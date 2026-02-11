import axios from 'axios';
import React, { useCallback, useEffect, useState, useRef } from 'react';
import { FaSpinner } from 'react-icons/fa';
import { Document, DocumentSuggestion } from './DocumentProcessor';
import { Tooltip } from 'react-tooltip';
import { ReceiptClientStatus, ReceiptJobStatus, getReceiptStatusViewOptions, mapReceiptJobStatus } from './receiptStatus';
import { readActualBudgetId } from './actualBudgetStorage';
type OCRPageResult = {
  text: string;
  ocrLimitHit: boolean;
  generationInfo?: Record<string, any>;
};
type ReceiptCartItemResult = {
  title?: string;
  generatedName?: string;
  category?: string;
  cost?: number;
};

type MatchedTransaction = {
  id?: string;
  parent_id?: string | null;
  account?: string;
  category?: string | null;
  date?: string;
  amount?: number;
  payee?: string;
  notes?: string;
  imported_payee?: string | null;
  transfer_id?: string | null;
  sort_order?: number;
  cleared?: boolean;
};

type ReceiptModelResult = {
  promptName?: string;
  combinedText?: string;
  payee?: string;
  matchedTransaction?: MatchedTransaction;
  transactionError?: string;
  perPageResults?: OCRPageResult[];
  cart?: ReceiptCartItemResult[];
  taxCents?: number;
};

type DocumentCustomField = {
  field: number;
  value: any;
  name?: string;
};

type DocumentWithCustomFields = Document & {
  custom_fields?: DocumentCustomField[];
};

type Account = {
  id: string;
  name: string;
  offBudget?: boolean;
  closed?: boolean;
}

type ReceiptRow = {
  title: string;
  generatedName: string;
  category: string;
  cost: number | null;
}

type ReceiptCategory = {
  id: string;
  name: string;
  group_id?: string;
  is_income?: boolean;
  hidden?: boolean;
};

type SettingsResponse = {
  settings?: {
    selected_receipt_categories?: ReceiptCategory[];
  };
  custom_fields?: CustomField[];
};

type ActualTransactionItem = {
  amount: number;
  category: string;
  notes?: string;
};

type ActualTransaction = {
  id?: string;
  parent_id?: string | null;
  account?: string;
  category?: string | null;
  amount?: number;
  payee?: string;
  notes?: string;
  date?: string;
  imported_payee?: string | null;
  transfer_id?: string | null;
  sort_order?: number;
  cleared?: boolean;
  subtransactions?: ActualTransactionItem[];
};

type CustomField = {
  id: number;
  name: string;
  data_type?: string;
};

const getItemTitles = (item: ReceiptCartItemResult): string[] => {
  const single = (item.title ?? "").trim();
  return single ? [single] : [];
};

const getItemGeneratedName = (item: ReceiptCartItemResult): string => {
  const single = (item.generatedName ?? "").trim();
  return single;
};

const getItemCost = (item: ReceiptCartItemResult): number | null => {
  const raw = item.cost;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return null;
};

const getItemCategory = (item: ReceiptCartItemResult): string => {
  const single = (item.category ?? "").trim();
  return single;
}

const normalizeCategoryKey = (value: string): string => value.trim().toLowerCase();

const normalizeCategoryLabel = (value?: string): string => {
  const trimmed = (value ?? "").trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed) return "";
  if (lower === "undefined" || lower === "null" || lower === "n/a" || lower === "none" || lower === "unknown") {
    return "";
  }
  return trimmed;
};

const resolveCategoryId = (
  categoryLabel: string,
  categories: ReceiptCategory[],
  nameLookup: Map<string, string>
): string | null => {
  const normalized = normalizeCategoryKey(categoryLabel);
  if (normalized) {
    const byName = nameLookup.get(normalized);
    if (byName) return byName;
  }
  const byId = categories.find((c) => c.id === categoryLabel);
  return byId ? byId.id : null;
};

const getRowNotes = (row: ReceiptRow): string => {
  const generated = (row.generatedName ?? "").trim();
  const title = (row.title ?? "").trim();
  if (generated && title && generated !== title) {
    return `${generated} (${title})`;
  }
  return generated || title;
};

const formatCurrencyFromCents = (cents: number | null | undefined): string => {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
};

const formatCostInputValue = (cents: number | null): string => {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
};

const parseCostInputToCents = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100);
};

const normalizeCustomFieldName = (value?: string): string => (value ?? "").trim().toLowerCase();

const normalizeCustomFieldType = (value?: string): string => (value ?? "").trim().toLowerCase();

const isIntegerFieldType = (value?: string): boolean => {
  const normalized = normalizeCustomFieldType(value);
  return normalized === "integer" || normalized === "int";
};

const getCustomFieldValue = (
  doc: DocumentWithCustomFields | null,
  fieldName: string
): any => {
  if (!doc?.custom_fields?.length) return null;
  const target = normalizeCustomFieldName(fieldName);
  const match = doc.custom_fields.find((field) => normalizeCustomFieldName(field.name) === target);
  return match?.value ?? null;
};

const parseCustomFieldNumber = (value: any): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/[$,]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return null;
    return parsed;
  }
  return null;
};

const parseCustomFieldInt = (value: any): number | null => {
  const parsed = parseCustomFieldNumber(value);
  if (parsed === null) return null;
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed);
};

const extractReceiptCustomFields = (doc: DocumentWithCustomFields | null) => {
  const totalTenderRaw = getCustomFieldValue(doc, "totalTender");
  const itemsSoldRaw = getCustomFieldValue(doc, "itemsSold");
  const totalTenderValue = parseCustomFieldNumber(totalTenderRaw);
  const itemsSoldValue = parseCustomFieldInt(itemsSoldRaw);
  const missing: string[] = [];

  if (totalTenderValue === null || !Number.isFinite(totalTenderValue) || totalTenderValue <= 0) {
    missing.push("totalTender");
  }
  if (itemsSoldValue === null || !Number.isFinite(itemsSoldValue) || itemsSoldValue <= 0) {
    missing.push("itemsSold");
  }

  return {
    totalTenderValue: totalTenderValue === null ? null : Math.abs(totalTenderValue),
    itemsSoldValue,
    error: missing.length ? `Missing or invalid custom fields: ${missing.join(", ")}` : null,
  };
};

// const alignCategories = (categories: string[], count: number): string[] => {
//   if (count <= 0) return [];
//   if (categories.length === count) return categories;
//   if (categories.length === 1) return Array(count).fill(categories[0]);
//   return Array(count).fill("");
// };

const buildReceiptRows = (result: ReceiptModelResult): ReceiptRow[] => {
  const cartItems =
    (Array.isArray(result.cart) && result.cart) ||
    [];

  return cartItems.flatMap((item) => {
    const titles = getItemTitles(item);
    const generatedName = getItemGeneratedName(item);
    const category = getItemCategory(item);
    const cost = getItemCost(item);
    return titles.map((title) => ({
      title,
      generatedName,
      category,
      cost,
    }));
  });
}

const Receipt: React.FC = () => {
  const refreshInterval = 1000; // Refresh interval in milliseconds
  const inputClassName =
    "border border-gray-300 dark:border-gray-700 rounded w-full p-2 focus:outline-none focus:ring-2 focus:ring-blue-500 !text-black placeholder:text-black dark:!text-black-100 dark:placeholder:text-gray-400";
  const [budgetId] = useState(readActualBudgetId);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [documentId, setDocumentId] = useState(0);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
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
  const [documentDetails, setDocumentDetails] = useState<DocumentWithCustomFields | null>(null);
  const [perPageResults, setPerPageResults] = useState<OCRPageResult[]>([]);
  //const [receiptPromptName, setReceiptPromptName] = useState('');
  //const [cartTitlesFieldValue, setCartTitlesFieldValue] = useState('');
  const [cartRows, setCartRows] = useState<ReceiptRow[]>([]);
  const [receiptDate, setReceiptDate] = useState<string>('');
  const [payee, setPayee] = useState<string>('');
  const [matchedTransaction, setMatchedTransaction] = useState<MatchedTransaction | null>(null);
  const [transactionError, setTransactionError] = useState<string | null>(null);
  const [receiptCategories, setReceiptCategories] = useState<ReceiptCategory[]>([]);
  const [receiptCategoriesLoading, setReceiptCategoriesLoading] = useState(false);
  const [receiptCategoriesError, setReceiptCategoriesError] = useState<string | null>(null);
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [savingReceipt, setSavingReceipt] = useState(false);
  const [saveReceiptMessage, setSaveReceiptMessage] = useState<string | null>(null);
  const [saveReceiptError, setSaveReceiptError] = useState<string | null>(null);
  const lastFetchedPagesDoneRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [reReceiptLoading, setReReceiptLoading] = useState<{ [pageIdx: number]: boolean }>({});
  const [reReceiptErrors, setReReceiptErrors] = useState<{ [pageIdx: number]: string }>({});
  const [reReceiptAbortControllers, setReReceiptAbortControllers] = useState<{ [pageIdx: number]: AbortController | null }>({});


  useEffect(() => {
    if (!budgetId) return;
      let cancelled = false
      const loadAccounts = async () => {
        setAccountsLoading(true);
        setAccountsError(null);
        try {
          const resp = await axios.get<Account[]>(`./api/actual/budgets/${budgetId}/accounts`)
          const sorted = [...resp.data].sort((a, b) => a.name.localeCompare(b.name));
          if (!cancelled) setAccounts(sorted);
        } catch (err){
          console.error("Failed to load accounts:", err);
          if (!cancelled) setAccountsError("Failed to Load accounts");
          console.error(accountsError)        
        } finally {
          if (!cancelled) setAccountsLoading(false);
        }
      };
      loadAccounts();
    return () => {cancelled = true; };
  }, [budgetId]);

  useEffect(() => {
    let cancelled = false;
    const loadReceiptCategories = async () => {
      setReceiptCategoriesLoading(true);
      setReceiptCategoriesError(null);
      try {
        const resp = await axios.get<SettingsResponse>("./api/settings");
        const selected = resp.data?.settings?.selected_receipt_categories ?? [];
        if (!cancelled) setReceiptCategories(selected);
        const availableCustomFields = resp.data?.custom_fields ?? [];
        if (!cancelled) setCustomFields(availableCustomFields);
      } catch (err) {
        console.error("Failed to load receipt categories:", err);
        if (!cancelled) setReceiptCategoriesError("Failed to load receipt categories.");
      } finally {
        if (!cancelled) setReceiptCategoriesLoading(false);
      }
    };
    loadReceiptCategories();
    return () => { cancelled = true; };
  }, [budgetId]);
  const stopReceiptJob = async () => {
    if (!receiptJobId) return;
    try {
      await axios.post(`./api/jobs/receipts/${receiptJobId}/stop`);
      setReceiptJobStatus('cancelled');
    } catch (err) {
      setError('Failed to stop Receipt job.');
    }
  };

  const fetchDocumentDetails = useCallback(
    async (
      overrideId?: number,
      options?: { prefillCustomFields?: boolean }
    ): Promise<DocumentWithCustomFields | null> => {
    const targetId = overrideId ?? documentId;
    if (!targetId) return null;

    try {
      const response = await axios.get<DocumentWithCustomFields>(`./api/documents/${targetId}`);
      const doc = response.data;
      setDocumentDetails(doc);
      if (options?.prefillCustomFields !== false) {
        const { totalTenderValue, itemsSoldValue } = extractReceiptCustomFields(doc);
        if (typeof totalTenderValue === "number") {
          setTotalTender(totalTenderValue);
        }
        if (typeof itemsSoldValue === "number") {
          setItemsSold(itemsSoldValue);
        }
      }
      return doc;
    } catch (err) {
      console.error("Error fetching document details:", err);
      setError("Failed to fetch document details.");
      return null;
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

  const resolveCustomField = useCallback(
    (fieldName: string): CustomField | null => {
      const normalized = normalizeCustomFieldName(fieldName);
      if (!normalized) return null;
      const match = customFields.find(
        (field) => normalizeCustomFieldName(field.name) === normalized
      );
      return match ?? null;
    },
    [customFields]
  );

  const updateReceiptCustomFields = async (doc: DocumentWithCustomFields) => {
    const targetDocumentId = doc.id ?? documentId;
    if (!targetDocumentId) {
      throw new Error("Missing document ID for custom field update.");
    }
    const totalTenderField = resolveCustomField("totalTender");
    const itemsSoldField = resolveCustomField("itemsSold");
    const totalTenderFieldId = totalTenderField?.id ?? null;
    const itemsSoldFieldId = itemsSoldField?.id ?? null;

    const missing: string[] = [];
    if (!totalTenderFieldId) missing.push("totalTender");
    if (!itemsSoldFieldId) missing.push("itemsSold");
    if (missing.length > 0) {
      throw new Error(`Missing custom fields in Paperless: ${missing.join(", ")}`);
    }

    const totalTenderValue =
      typeof totalTender === "number" && Number.isFinite(totalTender) ? totalTender : 0;
    const itemsSoldValue =
      typeof itemsSold === "number" && Number.isFinite(itemsSold) ? Math.round(itemsSold) : 0;

    if (totalTenderValue <= 0 || itemsSoldValue <= 0) {
      throw new Error("Total tender and items sold must be greater than 0.");
    }

    const totalTenderPayloadValue = isIntegerFieldType(totalTenderField?.data_type)
      ? -Math.round(Math.abs(totalTenderValue) * 100)
      : -Math.abs(totalTenderValue);
    const itemsSoldPayloadValue = isIntegerFieldType(itemsSoldField?.data_type)
      ? Math.round(itemsSoldValue)
      : itemsSoldValue;

    const requestPayload = [
      {
        id: targetDocumentId,
        original_document: doc,
        suggested_custom_fields: [
          { id: totalTenderFieldId, name: "totalTender", value: totalTenderPayloadValue },
          { id: itemsSoldFieldId, name: "itemsSold", value: itemsSoldPayloadValue },
        ],
        custom_fields_write_mode: "update",
      },
    ];

    await axios.patch("./api/update-documents", requestPayload);
  };

  const uploadReceiptFile = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    setUploadMessage(null);
    setError(null);
    setMessage(null);
    setReceiptJobId('');
    setOcrResult('');
    setPagesDone(0);
    setPerPageResults([]);
    setReceiptJobStatus('idle');
    setClientStatus('idle');
    setPayee('');
    setMatchedTransaction(null);
    setTransactionError(null);
    setCartRows([]);
    setTotalPages(null);
    setTotalTender(0);
    setItemsSold(0);
    lastFetchedPagesDoneRef.current = 0;
    setDocumentId(0);
    setDocumentDetails(null);

    try {
      const formData = new FormData();
      formData.append('document', file, file.name);
      const response = await axios.post("./api/documents/upload", formData);
      const newDocumentId = Number(response.data?.document_id);
      if (!Number.isFinite(newDocumentId) || newDocumentId <= 0) {
        throw new Error("Upload did not return a document ID.");
      }
      setDocumentId(newDocumentId);
      setUploadMessage(`Uploaded as document ${newDocumentId}.`);
      await fetchDocumentDetails(newDocumentId);
    } catch (err: any) {
      console.error("Upload failed:", err);
      const message =
        err?.response?.data?.error ||
        err?.message ||
        "Failed to upload receipt.";
      setUploadError(message);
    } finally {
      setUploading(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setSelectedFileName(file.name);
    void uploadReceiptFile(file);
    event.target.value = "";
  };

  const submitReceiptJob = async () => {
    setError(null);
    setMessage(null);
    setReceiptJobId('');
    setOcrResult('');
    //setReceiptPromptName('');
    //setCartTitlesFieldValue('');
    setPagesDone(0);
    setPerPageResults([]);
    setReceiptJobStatus('idle');
    setClientStatus('fetching_details');
    setPayee('');
    setMatchedTransaction(null);
    setTransactionError(null);
    lastFetchedPagesDoneRef.current = 0;

    try {
      let doc = documentDetails;
      if (!doc) {
        doc = await fetchDocumentDetails(undefined, { prefillCustomFields: false });
      }
      if (!doc) {
        throw new Error("Document details not loaded.");
      }
      await updateReceiptCustomFields(doc);

      // Convert currency to integer cents for the backend (which expects an int)
      //const totalTenderCents = Math.round((Number(totalTender) || 0) * 100);
      const totalReceiptCents = -Math.round((totalTender || 0) * 100);
      setClientStatus('submitting');
      const response = await axios.post(`./api/documents/${documentId}/receipt`, {
        documentId,
        totalTender: totalReceiptCents,
        itemsSold,
        receiptDate,
        budgetId,
        accountId: selectedAccountId,
      });
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
        let parsedResult: ReceiptModelResult | null = null;
        try {
          parsedResult = JSON.parse(response.data.result);
        } catch (e) {
          setOcrResult(response.data.result);
          //setReceiptPromptName('');
          //setCartTitlesFieldValue('');
          return;
        }
        if (parsedResult) {
          setOcrResult(parsedResult.combinedText ?? '');
          setPerPageResults(Array.isArray(parsedResult.perPageResults) ? parsedResult.perPageResults : []);
          setPayee((parsedResult.payee ?? '').trim());
          setMatchedTransaction(parsedResult.matchedTransaction ?? null);
          setTransactionError((parsedResult.transactionError ?? '').trim() || null);
          //setReceiptPromptName(parsedResult.promptName ?? '');

          const rows = buildReceiptRows(parsedResult);
          setCartRows(rows);
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

  const handleSaveReceipt = async () => {
    setSavingReceipt(true);
    setSaveReceiptError(null);
    setSaveReceiptMessage(null);
    try {
      if (!budgetId) {
        throw new Error("Missing budget ID.");
      }
      if (!selectedAccountId) {
        throw new Error("Missing account selection.");
      }
      if (!matchedTransaction?.id) {
        throw new Error("No matched transaction to update.");
      }
      const fallbackAmount = -Math.round((Number(totalTender) || 0) * 100);
      const transactionAmount =
        typeof matchedTransaction.amount === "number" && Number.isFinite(matchedTransaction.amount)
          ? matchedTransaction.amount
          : fallbackAmount;
      if (!Number.isFinite(transactionAmount) || transactionAmount === 0) {
        throw new Error("Transaction amount is missing or invalid.");
      }
      const transactionDate = (matchedTransaction.date ?? "").trim() || receiptDate;
      if (!transactionDate) {
        throw new Error("Receipt date is missing.");
      }
      if (matchedTransaction.sort_order === undefined || matchedTransaction.sort_order === null) {
        throw new Error("Matched transaction is missing sort order.");
      }
      if (matchedTransaction.cleared === undefined || matchedTransaction.cleared === null) {
        throw new Error("Matched transaction is missing cleared status.");
      }
      if (receiptCategoriesLoading) {
        throw new Error("Receipt categories are still loading.");
      }
      if (receiptCategories.length === 0) {
        throw new Error("No receipt categories loaded. Please select categories in Connections.");
      }

      const categoryLookup = new Map<string, string>();
      for (const c of receiptCategories) {
        if (!c?.name || !c?.id) continue;
        categoryLookup.set(normalizeCategoryKey(c.name), c.id);
      }

      const amountSign = transactionAmount < 0 ? -1 : 1;
      const subtransactions: ActualTransactionItem[] = [];
      let defaultCategoryId: string | null = null;

      for (const row of cartRows) {
        const cost = row.cost;
        if (!Number.isFinite(cost) || cost === 0) continue;
        const categoryLabel = normalizeCategoryLabel(row.category);
        let categoryId: string | null = null;
        if (categoryLabel) {
          categoryId = resolveCategoryId(categoryLabel, receiptCategories, categoryLookup);
        } else {
          categoryId = defaultCategoryId ?? null;
        }
        if (categoryId && !defaultCategoryId) {
          defaultCategoryId = categoryId;
        }
        const notes = getRowNotes(row);
        subtransactions.push({
          amount: amountSign * Math.round(cost as number),
          category: categoryId ?? "",
          ...(notes ? { notes } : {}),
        });
      }

      if (subtransactions.length === 0) {
        throw new Error("No receipt items with cost to save.");
      }

      const taxCents = Number.isFinite(computedTaxCents) ? computedTaxCents : 0;
      if (Number.isFinite(taxCents) && taxCents !== 0) {
        const taxCategoryLabel = "Sales Tax";
        const taxCategoryId =
          resolveCategoryId(taxCategoryLabel, receiptCategories, categoryLookup) ||
          defaultCategoryId ||
          "";
        subtransactions.push({
          amount: amountSign * Math.round(taxCents),
          category: taxCategoryId,
          notes: "Sales tax",
        });
      }

      const transactionPayload: ActualTransaction = {
        id: matchedTransaction.id,
        parent_id: matchedTransaction.parent_id ?? null,
        account: selectedAccountId,
        category: null,
        amount: transactionAmount,
        date: transactionDate,
        payee: matchedTransaction.payee || "",
        ...(matchedTransaction.notes ? { notes: matchedTransaction.notes } : {}),
        ...(matchedTransaction.imported_payee !== undefined
          ? { imported_payee: matchedTransaction.imported_payee }
          : {}),
        ...(matchedTransaction.transfer_id !== undefined
          ? { transfer_id: matchedTransaction.transfer_id }
          : {}),
        sort_order: matchedTransaction.sort_order,
        cleared: matchedTransaction.cleared,
        subtransactions,
      };

      const endpoint = `./api/actual/budgets/${encodeURIComponent(budgetId)}/${encodeURIComponent(
        matchedTransaction.id
      )}`;

      await axios.post(endpoint, transactionPayload);
      setSaveReceiptMessage("Receipt saved to Actual.");
    } catch (err: any) {
      console.error("Error saving receipt:", err);
      setSaveReceiptError(err?.message || "Failed to save receipt.");
    } finally {
      setSavingReceipt(false);
    }
  };

  const updateCartRow = useCallback((index: number, updater: (row: ReceiptRow) => ReceiptRow) => {
    setCartRows((prev) => prev.map((row, i) => (i === index ? updater(row) : row)));
  }, []);

  const handleGeneratedNameChange = useCallback(
    (index: number, value: string) => {
      updateCartRow(index, (row) => ({
        ...row,
        generatedName: value,
      }));
    },
    [updateCartRow]
  );

  const handleCostChange = useCallback(
    (index: number, value: string) => {
      const nextCost = parseCostInputToCents(value);
      updateCartRow(index, (row) => ({
        ...row,
        cost: nextCost,
      }));
    },
    [updateCartRow]
  );

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
  const totalTenderCents = Math.round((Number(totalTender) || 0) * 100);
  const subtotalCents = cartRows.reduce((sum, row) => {
    if (typeof row.cost !== "number" || !Number.isFinite(row.cost)) return sum;
    return sum + row.cost;
  }, 0);
  const computedTaxCents = totalTenderCents - subtotalCents;
  const subtotalExceedsTotal = totalTenderCents > 0 && subtotalCents > totalTenderCents;
  const canSubmitReceiptJob =
    Boolean(documentId) &&
    !uploading &&
    Number.isFinite(totalTender) &&
    Number.isFinite(itemsSold) &&
    totalTender > 0 &&
    itemsSold > 0;
  const canSaveReceipt =
    Boolean(budgetId) &&
    Boolean(selectedAccountId) &&
    Boolean(matchedTransaction?.id) &&
    cartRows.length > 0 &&
    !receiptCategoriesLoading &&
    !subtotalExceedsTotal;

  return (
    <div className="max-w-3xl mx-auto p-6 bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200">
      <h1 className="text-4xl font-bold mb-6 text-center">OCR via LLMs (Experimental)</h1>
      <p className="mb-6 text-center text-yellow-600">
        This is an experimental feature. Results may vary, and processing may take some time.
      </p>
      <div className="bg-gray-100 dark:bg-gray-800 p-6 rounded-lg shadow-md">
        <div className="mb-4">
          <label className="block mb-2 font-semibold">Receipt File:</label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <input
              type="file"
              ref={fileInputRef}
              className="hidden"
              accept="image/*,application/pdf"
              onChange={handleFileChange}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded transition duration-200 disabled:bg-blue-300 disabled:cursor-not-allowed"
              disabled={uploading}
            >
              {uploading ? (
                <span className="flex items-center justify-center">
                  <FaSpinner className="animate-spin mr-2" />
                  Uploading...
                </span>
              ) : (
                "Choose File"
              )}
            </button>
            <span className="text-sm text-gray-600 dark:text-gray-400">
              {selectedFileName || "No file selected"}
            </span>
          </div>
          {documentId > 0 && (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
              Document ID: {documentId}
            </p>
          )}
          {uploadMessage && (
            <p className="mt-2 text-sm text-green-600">{uploadMessage}</p>
          )}
          {uploadError && (
            <p className="mt-2 text-sm text-red-600">{uploadError}</p>
          )}
        </div>
        <div className="mb-4">
          <label htmlFor="accountId" className="block mb-2 font-semibold">
            Account:
          </label>
          <select
            id="accountId"
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            className={inputClassName}
            disabled={!budgetId || accountsLoading}
          >
            <option value="">
              {!budgetId
                ? "Select a budget in Connections"
                : accountsLoading
                ? "Loading accounts..."
                : "Select an Account"}
            </option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          {accountsError && (
            <p className="mt-2 text-sm text-red-600">{accountsError}</p>
          )}
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
            className={inputClassName}
            placeholder="0.00"
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
            className={inputClassName}
            placeholder="0"
          />
        </div>
        <div className="mb-4">
          <label htmlFor="receiptDate" className="block mb-2 font-semibold">
            Receipt Date:
          </label>
          <input
            type="date"
            id="receiptDate"
            value={receiptDate}
            onChange={(e) => setReceiptDate(e.target.value)}
            className={inputClassName}
            placeholder="4/20"
          />
        </div>
        <button
          onClick={submitReceiptJob}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded transition duration-200"
          disabled={!canSubmitReceiptJob}
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
        {(receiptJobStatus === 'completed' || payee) && (
          <div className="mt-4">
            <div className="font-semibold">Receipt Payee</div>
            <div className="text-gray-700 dark:text-gray-300">
              {payee || "—"}
            </div>
          </div>
        )}
        {(matchedTransaction || transactionError) && (
          <div className="mt-4">
            <div className="font-semibold">Matched Transaction</div>
            {matchedTransaction ? (
              <div className="text-gray-700 dark:text-gray-300">
                {matchedTransaction.payee || "—"}
              </div>
            ) : (
              <div className="text-sm text-gray-500">
                {transactionError || "No match found."}
              </div>
            )}
          </div>
        )}
        {cartRows.length > 0 && (
          <div className="mt-4">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <th className="text-left border-b p-2">Item</th>
                  <th className="text-left border-b p-2">Generated Name</th>
                  <th className="text-center border-b p-2">Category</th>
                  <th className="text-right border-b p-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {cartRows.map((row, i) => (
                  <tr key={`${row.title}-${i}`}>
                    <td className="p-2 border-b">{row.title}</td>
                    <td className="p-2 border-b">
                      <input
                        type="text"
                        value={row.generatedName}
                        onChange={(e) => handleGeneratedNameChange(i, e.target.value)}
                        className={`${inputClassName} text-sm`}
                        placeholder="Generated name"
                      />
                    </td>
                    <td className="p-2 border-b text-center">{row.category}</td>
                    <td className="p-2 border-b text-right">
                      <input
                        type="number"
                        step="0.01"
                        min="0"
                        value={formatCostInputValue(row.cost)}
                        onChange={(e) => handleCostChange(i, e.target.value)}
                        className={`${inputClassName} text-right text-sm`}
                        placeholder="0.00"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
              <div className="flex justify-between">
                <span className="font-semibold">Subtotal</span>
                <span>{formatCurrencyFromCents(subtotalCents)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-semibold">Tax</span>
                <span>{formatCurrencyFromCents(computedTaxCents)}</span>
              </div>
              <div className="flex justify-between">
                <span className="font-semibold">Total</span>
                <span>{formatCurrencyFromCents(totalTenderCents)}</span>
              </div>
            </div>
            {subtotalExceedsTotal && (
              <p className="mt-2 text-sm text-red-600">
                Subtotal exceeds total tender. Adjust item costs so subtotal is not greater than total to enable saving.
              </p>
            )}
            <div className="mt-4">
              <button
                onClick={handleSaveReceipt}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition duration-200"
                disabled={!canSaveReceipt || savingReceipt}
              >
                {savingReceipt ? (
                  <span className="flex items-center justify-center">
                    <FaSpinner className="animate-spin mr-2" />
                    Saving Receipt...
                  </span>
                ) : (
                  'Save Receipt to Actual'
                )}
              </button>
              {!matchedTransaction?.id && (
                <p className="mt-2 text-sm text-gray-500">
                  Match a transaction before saving to Actual.
                </p>
              )}
              {receiptCategoriesError && (
                <p className="mt-2 text-sm text-red-600">{receiptCategoriesError}</p>
              )}
              {saveReceiptError && (
                <div className="mt-3 p-3 bg-red-100 dark:bg-red-800 text-red-700 dark:text-red-200 rounded">
                  {saveReceiptError}
                </div>
              )}
              {saveReceiptMessage && (
                <div className="mt-3 p-3 bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 rounded">
                  {saveReceiptMessage}
                </div>
              )}
            </div>
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
