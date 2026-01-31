import axios from 'axios';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { FaSpinner } from 'react-icons/fa';
import { Document, DocumentSuggestion } from './DocumentProcessor';
import { Tooltip } from 'react-tooltip';
import { ReceiptClientStatus, ReceiptJobStatus, getReceiptStatusViewOptions, mapReceiptJobStatus } from './receiptStatus';

type OCRPageResult = {
  text: string;
  ocrLimitHit: boolean;
  generationInfo?: Record<string, any>;
};
type OCRCombinedResult = { combinedText: string; perPageResults: OCRPageResult[] };

const Receipt: React.FC = () => {
  const refreshInterval = 1000; // Refresh interval in milliseconds
  const [documentId, setDocumentId] = useState(0);
  const [totalTender, setTotalTender] = useState(0);
  const [itemsSold, setItemsSold] = useState(0);
  const [receiptJobId, setReceiptJobId] = useState('');
  const [ocrResult, setOcrResult] = useState('');
  const [receiptJobStatus, setReceiptJobStatus] = useState<ReceiptJobStatus>('idle');
  const [clientStatus, setClientStatus] = useState<ReceiptClientStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pagesDone, setPagesDone] = useState(0);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [documentDetails, setDocumentDetails] = useState<Document | null>(null);
  const [perPageResults, setPerPageResults] = useState<OCRPageResult[]>([]);
  const lastFetchedPagesDoneRef = useRef(0);

  const [reReceiptLoading, setReReceiptLoading] = useState<{ [pageIdx: number]: boolean }>({});
  const [reReceiptErrors, setReReceiptErrors] = useState<{ [pageIdx: number]: string }>({});
  const [reReceiptAbortControllers, setReReceiptAbortControllers] = useState<{ [pageIdx: number]: AbortController | null }>({});

  const stopReceiptJob = async () => {
    if (!receiptJobId) return;
    try {
      await axios.post(`./api/jobs/receipts/${receiptJobId}/stop`);
      setReceiptJobStatus('cancelled');
    } catch (err) {
      setError('Failed to stop Receipt job.');
    }
  };

  const fetchDocumentDetails = useCallback(async () => {
    if (!documentId) return;

    try {
      const response = await axios.get<Document>(`./api/documents/${documentId}`);
      setDocumentDetails(response.data);
    } catch (err) {
      console.error("Error fetching document details:", err);
      setError("Failed to fetch document details.");
    }
  }, [documentId]);

  const fetchPerPageResults = useCallback(async () => {
    if (!documentId) return;
    try {
      const response = await axios.get<{ pages: OCRPageResult[] }>(`./api/documents/${documentId}/ocr_pages`);
      setPerPageResults(response.data.pages);
    } catch (err) {
      console.error("Error fetching per-page OCR results:", err);
      setError("Failed to fetch per-page OCR results.");
    }
  }, [documentId]);

  const submitReceiptJob = async () => {
    setError(null);
    setMessage(null);
    setReceiptJobId('');
    setOcrResult('');
    setPagesDone(0);
    setPerPageResults([]);
    setReceiptJobStatus('idle');
    setClientStatus('fetching_details');
    lastFetchedPagesDoneRef.current = 0;

    try {
      await fetchDocumentDetails();

      setClientStatus('submitting');
      const response = await axios.post(`./api/documents/${documentId}/receipt`);
      setReceiptJobId(response.data.receiptJob_id);
      setReceiptJobStatus('pending');
      setClientStatus('idle');
    } catch (err) {
      console.error(err);
      setError('Failed to submit OCR job.');
      setClientStatus('idle');
    }
  };

  const checkReceiptJobStatus = async () => {
    if (!receiptJobId) return;

    try {
      const response = await axios.get(`./api/jobs/receipts/${receiptJobId}`);
      const newReceiptJobStatus = mapReceiptJobStatus(response.data.status);
      setReceiptJobStatus(newReceiptJobStatus);
      const newPagesDone = response.data.pages_done;
      setPagesDone(newPagesDone);
      setTotalPages(response.data.total_pages ?? null);

      if (newPagesDone > lastFetchedPagesDoneRef.current) {
        await fetchPerPageResults();
        lastFetchedPagesDoneRef.current = newPagesDone;
      }

      if (newReceiptJobStatus === 'completed') {
        let parsedResult: OCRCombinedResult | null = null;
        try {
          parsedResult = JSON.parse(response.data.result);
        } catch (e) {
          setOcrResult(response.data.result);
          return;
        }
        if (parsedResult) {
          setOcrResult(parsedResult.combinedText);
          setPerPageResults(parsedResult.perPageResults);
        }
      } else if (newReceiptJobStatus === 'failed') {
        setError(response.data.error);
      } else {
        setTimeout(() => checkReceiptJobStatus(), refreshInterval);
      }
    } catch (err) {
      console.error(err);
      setError('Failed to check Receipt job status.');
    }
  };

  const handleSaveContent = async () => {
    setSaving(true);
    setError(null);
    try {
      if (!documentDetails) {
        setError('Document details not fetched.');
        throw new Error('Document details not fetched.');
      }
      const requestPayload: DocumentSuggestion = {
        id: documentId,
        original_document: documentDetails,
        suggested_content: ocrResult,
      };

      await axios.patch("./api/update-documents", [requestPayload]);
      setMessage('Content saved successfully.');
    } catch (err) {
      console.error("Error saving content:", err);
      setError("Failed to save content.");
    } finally {
      setSaving(false);
    }
  };

  const handleReReceiptPage = async (pageIdx: number) => {
    if (!perPageResults[pageIdx]) {
      setReReceiptErrors((prev) => ({ ...prev, [pageIdx]: "Page data not available." }));
      return;
    }
    
    setReReceiptLoading((prev) => ({ ...prev, [pageIdx]: true }));
    setReReceiptErrors((prev) => ({ ...prev, [pageIdx]: "" }));
    
    const controller = new AbortController();
    setReReceiptAbortControllers((prev) => ({ ...prev, [pageIdx]: controller }));
    
    try {
      const response = await axios.post(
        `./api/documents/${documentId}/ocr_pages/${pageIdx}/reocr`,
        {},
        { signal: controller.signal }
      );

      setPerPageResults((prev) =>
        prev.map((res, idx) =>
          idx === pageIdx
            ? {
                text: response.data.text,
                ocrLimitHit: response.data.ocrLimitHit,
                generationInfo: response.data.generationInfo,
              }
            : res
        )
      );
      
      if (pageIdx + 1 > lastFetchedPagesDoneRef.current) {
        lastFetchedPagesDoneRef.current = pageIdx + 1;
      }
    } catch (err: any) {
      if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
        setReReceiptErrors((prev) => ({
          ...prev,
          [pageIdx]: "Re-OCR cancelled.",
        }));
      } else {
        setReReceiptErrors((prev) => ({
          ...prev,
          [pageIdx]: "Failed to re-OCR page.",
        }));
      }
    } finally {
      setReReceiptLoading((prev) => ({ ...prev, [pageIdx]: false }));
      setReReceiptAbortControllers((prev) => ({ ...prev, [pageIdx]: null }));
    }
  
  };
  const handleCancelReReceiptPage = async (pageIdx: number) => {
    const controller = reReceiptAbortControllers[pageIdx];
    if (controller) {
      controller.abort();
    }
    try {
      await axios.delete(`./api/documents/${documentId}/ocr_pages/${pageIdx}/reocr`);
      console.log(`Cancellation request sent for page ${pageIdx}`);
    } catch (err) {
      console.error(`Failed to send cancellation request for page ${pageIdx}:`, err);
    }
  };

  useEffect(() => {
    if (receiptJobId) {
      lastFetchedPagesDoneRef.current = 0;
      checkReceiptJobStatus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receiptJobId]);

  const statusViewOptions = getReceiptStatusViewOptions(receiptJobStatus, clientStatus);

  return (
    <div className="max-w-3xl mx-auto p-6 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200">
      <h1 className="text-4xl font-bold mb-6 text-center">OCR via LLMs (Experimental)</h1>
      <p className="mb-6 text-center text-yellow-600">
        This is an experimental feature. Results may vary, and processing may take some time.
      </p>
      <div className="bg-gray-100 dark:bg-gray-800 p-6 rounded-lg shadow-md">
        <div className="mb-4">
          <label htmlFor="documentId" className="block mb-2 font-semibold">
            Document ID:
          </label>
          <input
            type="number"
            id="documentId"
            value={documentId}
            onChange={(e) => setDocumentId(Number(e.target.value))}
            className="border border-gray-300 dark:border-gray-700 rounded w-full p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter the document ID"
          />
        </div>
        <div className="mb-4">
          <label htmlFor="totalTender" className="block mb-2 font-semibold">
            Total Tender:
          </label>
          <input
            type="number"
            id="totalTender"
            value={totalTender}
            onChange={(e) => setTotalTender(Number(e.target.value))}
            className="border border-gray-300 dark:border-gray-700 rounded w-full p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter the Total Tendered"
          />
        </div>
        <div className="mb-4">
          <label htmlFor="itemsSold" className="block mb-2 font-semibold">
            Items Sold:
          </label>
          <input
            type="number"
            id="itemsSold"
            value={itemsSold}
            onChange={(e) => setItemsSold(Number(e.target.value))}
            className="border border-gray-300 dark:border-gray-700 rounded w-full p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter the Total Tendered"
          />
        </div>
        <button
          onClick={submitReceiptJob}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
          disabled={!documentId}
        >
          {clientStatus === 'submitting' ? (
            <span className="flex items-center justify-center">
              <FaSpinner className="animate-spin mr-2" />
              Submitting...
            </span>
          ) : (
            'Submit Receipt Job'
          )}
        </button>
        {(statusViewOptions.label || pagesDone > 0) && (
          <div className="mt-4 text-center text-gray-700 dark:text-gray-300">
            {statusViewOptions.showSpinner ? (
              <span className="flex items-center justify-center">
                <FaSpinner className="animate-spin mr-2" />
                {statusViewOptions.label}
              </span>
            ) : (
              statusViewOptions.label
            )}
            {pagesDone > 0 && (
              <div className="mt-2">
                {totalPages && totalPages > 1
                  ? `Pages processed: ${pagesDone} / ${totalPages}`
                  : `Pages processed: ${pagesDone}`}
              </div>
            )}
            {receiptJobId && statusViewOptions.canStop && (
              <button
                onClick={stopReceiptJob}
                className="mt-4 bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
              >
                Stop Job
              </button>
            )}
          </div>
        )}
        {error && (
          <div className="mt-4 p-4 bg-red-100 dark:bg-red-800 text-red-700 dark:text-red-200 rounded">
            {error}
          </div>
        )}
        {message && (
          <div className="mt-4 p-4 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
            {message}
          </div>
        )}
        {perPageResults.length > 0 && totalPages && totalPages > 1 && (
          <div className="mt-6">
            <h2 className="text-2xl font-bold mb-4">Per-Page OCR Results:</h2>
            {perPageResults.map((page, idx) => (
              <div key={idx} className="mb-6 border border-gray-300 dark:border-gray-700 rounded p-4 bg-white dark:bg-gray-900">
                <div className="flex items-center mb-2">
                  <span className="font-semibold mr-2">Page {idx + 1}</span>
                  {page.ocrLimitHit && (
                    <span className="ml-2 px-2 py-1 bg-yellow-200 text-yellow-800 rounded text-xs font-bold">
                      Token Limit Hit
                    </span>
                  )}
                  {page.generationInfo && Object.keys(page.generationInfo).length > 0 && (
                    <>
                      <span
                        data-tooltip-id={`geninfo-tooltip-${idx}`}
                        className="ml-3 cursor-pointer text-blue-600 hover:text-blue-800"
                        tabIndex={0}
                        aria-label="Show Generation Info"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="inline-block" width="18" height="18" fill="currentColor" viewBox="0 0 20 20">
                          <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm.75-12.25a.75.75 0 11-1.5 0 .75.75 0 011.5 0zM9 9.25A1 1 0 0110 8.5h.01a1 1 0 01.99 1v4a1 1 0 01-2 0v-4z"/>
                        </svg>
                      </span>
                      <Tooltip
                        id={`geninfo-tooltip-${idx}`}
                        place="top"
                        className="!max-w-xs !text-xs"
                        style={{ zIndex: 9999 }}
                        clickable={true}
                        render={() => (
                          <div className="p-1">
                            <table>
                              <tbody>
                                {Object.entries(page.generationInfo ?? {}).map(([key, value]) => (
                                  <tr key={key}>
                                    <td className="pr-2 font-semibold align-top">{key}:</td>
                                    <td className="break-all">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      />
                    </>
                  )}
                </div>
                <pre className="whitespace-pre-wrap bg-gray-50 dark:bg-gray-800 p-2 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-48">
                  {page.text}
                </pre>
                <div className="mt-2 flex flex-col sm:flex-row items-start sm:items-center gap-2">
                  <div className="flex flex-row items-center gap-2">
                    <button
                      onClick={() => handleReReceiptPage(idx)}
                      className="bg-orange-600 hover:bg-orange-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
                      disabled={reReceiptLoading[idx]}
                    >
                      {reReceiptLoading[idx] ? (
                        <span className="flex items-center">
                          <FaSpinner className="animate-spin mr-2" />
                          Re-OCRing...
                        </span>
                      ) : (
                        'Re-OCR Page'
                      )}
                    </button>
                    {reReceiptLoading[idx] && (
                      <button
                        onClick={() => handleCancelReReceiptPage(idx)}
                        className="bg-gray-500 hover:bg-gray-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
                        style={{ marginLeft: 8 }}
                      >
                        Cancel Re-OCR
                      </button>
                    )}
                  </div>
                  {reReceiptErrors[idx] && (
                    <span className="text-red-600 text-sm ml-2">{reReceiptErrors[idx]}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {ocrResult && (
          <div className="mt-6">
            <h2 className="text-2xl font-bold mb-4">Combined OCR Result:</h2>
            <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-auto max-h-96">
              <pre className="whitespace-pre-wrap">{ocrResult}</pre>
            </div>
            <button
              onClick={handleSaveContent}
              className="w-full bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-4 rounded transition duration-200 mt-4"
              disabled={saving}
            >
              {saving ? (
                <span className="flex items-center justify-center">
                  <FaSpinner className="animate-spin mr-2" />
                  Saving...
                </span>
              ) : (
                'Save Content'
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default Receipt;
