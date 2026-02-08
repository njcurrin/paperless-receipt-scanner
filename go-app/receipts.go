package main

import (
	"context"
	"encoding/json"
	"os"
	"paperless-gpt/local_db"
	"strconv"
	"strings"

	//"encoding/json"

	"fmt"

	"github.com/sirupsen/logrus"
	//"os"
	//"path/filepath"
	//"strings"
	//"time"
	//"github.com/gardar/ocrchestra/pkg/hocr"
	//"github.com/gardar/ocrchestra/pkg/pdfocr"
	//"github.com/sirupsen/logrus"
	//"github.com/gin-gonic/gin"
)

type suggestedName struct {
	Title         string `json:"itemTitle"`
	SuggestedName string `json:"improvedTitle"`
}

func extractJSONObject(s string) (string, error) {
	s = strings.TrimSpace(s)

	// Strip fenced code blocks like ```json ... ```
	if strings.HasPrefix(s, "```") {
		// remove leading ```
		if idx := strings.Index(s, "\n"); idx != -1 {
			s = strings.TrimSpace(s[idx+1:])
		}
		// remove trailing ```
		if idx := strings.LastIndex(s, "```"); idx != -1 {
			s = strings.TrimSpace(s[:idx])
		}
	}

	start := strings.Index(s, "{")
	end := strings.LastIndex(s, "}")
	if start == -1 || end == -1 || end <= start {
		return "", fmt.Errorf("no JSON object found in response")
	}
	return s[start : end+1], nil
}

// type ProcessedReceipt struct {
// 	ID           int
// 	Title        string
// 	TradOCR      string
// 	VLMOCR       string
// 	receiptJobID string
// 	//PDFData      []byte
// }

// processReceiptHandler runs OCR in "receipt_scanner" mode for a document.
// totalTender/itemsSold come from the web request (via receiptJob) so we can steer the cart prompt.
func (app *App) processReceipt(ctx context.Context, documentID int, totalTender int64, itemsSold int, date string, options ReceiptOptions, receiptJobID string) (*local_db.Receipt, error) {
	// Steps to ProcessReceipt
	// 	Get Receipt Document Images from Paperless and convert to bytes for vlm
	//	ProcessDocumentOCR to get the OCRTotalTender and OCRItemsSold
	//	Check TotalTender and ItemsSold with OCR'd versions
	//		If different, cancel
	// 	ProcessReceiptCartItems() Pre-Flight
	//		Get Second Prompt and populate
	//			Prompt
	//			TradOCR
	//			TotalTender
	//			ItemsSold
	//	ProcessReceiptCartItems(ctx context.Context, prompt string, imagePath string, receiptJobID string) (*Cart, error)
	//		create Cart Array for Items
	// 			while Cart.len() < ItemsSold
	//				Prompt vlm with list of items already in cart and ask for the next one
	//				each response is a new item in the array
	//		cart.item[all].price - TotalTender = difference
	// 			if difference > 00.10
	//				Prompt vlm with cart.item[all].name and ask for prices for each item
	//				repeat up to twice
	//			if difference > 00.20 error
	//	This part is now completed for the most part, I haven't put much in the way or error correction as the model has been doing a really good job of spitting out exactly what it is supposed to with the current prompt

	//	ProcessCorrespondent(ctx context.Context, prompt string, imagePath string, receiptJobID) (*Correspondent, error)
	//		use vlm to get Correspondent
	//		get list of existing correspondents
	//		check if Correspondent exists using LLM
	//		if exists
	//			return Corespondent
	//		else create Corespondent in Paperless
	//	ProcessTitle()
	//		similar to Corespondent, no need to check if existing
	//	For now, return results to user

	// initializes the logger
	receiptLogger := documentLogger(documentID)
	if receiptJobID != "" {
		receiptLogger = receiptLogger.WithField("receiptJobID: ", receiptJobID)
	}

	// Carry forward user-supplied receipt metadata so downstream prompts know the target cart size/value.
	workReceipt := &local_db.Receipt{
		TotalTender: totalTender,
		ItemsSold:   itemsSold,
	}
	// log to docker
	receiptLogger.Info("Starting Receipt scan for ", receiptJobID)

	// set function variables
	//var ocrResults []*vlm.OCRResult
	var imageDataList [][]byte
	var totalImages int
	var imagePaths []string
	//var ocrTexts []string

	//What options are we using?
	processMode := options.ProcessMode
	if processMode == "" {
		processMode = app.ocrProcessMode // TODO: Make a new receipt_scanner default
	} else if processMode != "receipt_scanner" {
		return nil, fmt.Errorf("invalid ProcessMode: %s, must be one of: image, pdf, whole_pdf, receipt_scanner", processMode)
	}
	// Get and Populate the originalDocument so we can start prepping the rest
	originalDocument, err := app.Client.GetDocument(ctx, documentID)
	if err != nil {
		return nil, fmt.Errorf("error downloading document %d: %w", documentID, err)
	}
	pageLimit := limitOcrPages
	imagePaths, imagePageCount, err := app.Client.DownloadDocumentAsImages(ctx, documentID, pageLimit)
	defer func() {
		for _, imagePath := range imagePaths {
			if err := os.Remove(imagePath); err != nil {
				receiptLogger.WithError(err).WithField("image_path", imagePath).Warn("Failed to remove temp file")
			}
		}
	}()
	if err != nil {
		return nil, fmt.Errorf("Error downloading receipt images from document %d: %w", documentID, err)
	}

	totalImages = imagePageCount

	if receiptJobID != "" {
		receiptJobStore.Lock()
		if job, exists := receiptJobStore.receiptJobs[receiptJobID]; exists {
			job.TotalPages = totalImages
		}
		receiptJobStore.Unlock()
	}

	receiptLogger.WithFields(logrus.Fields{
		"processed_page_count": len(imagePaths),
		"total_page_count":     totalImages,
		"limit_pages":          pageLimit,
	}).Debug("Downloaded document images")

	for i, imagePath := range imagePaths {

		//cancel the job early but dump what we have so far to the Result
		select {
		case <-ctx.Done():
			receiptLogger.Info("Job cancelled before processing page")
			// Return partial results if cancelled
			return &local_db.Receipt{
				DocumentID: documentID,
			}, ctx.Err()
		default:
		}
		// for each image from the receipt do the following
		pageLogger := receiptLogger.WithField("page", i+1)
		pageLogger.Info("VLM OCR Starting")

		// load the image content so it can be sent to the vlmProvider
		imageContent, err := os.ReadFile(imagePath)
		if err != nil {
			return nil, fmt.Errorf("error reading tempory image file for document %d, page %d: %w", documentID, i+1, err)
		}

		imageDataList = append(imageDataList, imageContent)

		// for itemIdx := 0; i < workReceipt.ItemsSold; itemIdx++ {
		// 	previousItemTitle := workReceipt.Cart[i-1].Title
		// 	previousItemCost := workReceipt.Cart[i-1].Cost
		// 	if itemIdx == 0 {
		// 		previousItemTitle = ""
		// 	}

		updatedCart, err := app.vlmReceipts.ProcessReceiptCartItems(ctx, imageContent, workReceipt.ItemsSold, originalDocument.Content, receiptJobID)

		if err != nil {
			return nil, fmt.Errorf("error getting receipt item: %w", err)
		}
		subTotalCents := 0
		for _, item := range updatedCart {
			// pageLogger.Info("Items: ", item.Title)
			subTotalCents += item.Cost
		}
		pageLogger.Info("SubTotal: ", strconv.Itoa(subTotalCents))
		for idx := range updatedCart {
			var newName suggestedName
			response, err := app.getSuggestedTitle(ctx, originalDocument.Content, updatedCart[idx].Title, receiptLogger)
			if err != nil {
				return nil, fmt.Errorf("error getting receipt item: %w", err)
			}
			raw := response
			jsonText, err := extractJSONObject(raw)
			if err != nil {

				return nil, fmt.Errorf("unable to extract json")
			}
			dec := json.NewDecoder(strings.NewReader(jsonText))
			dec.UseNumber()
			logger.Info("Response:", jsonText)
			if err := dec.Decode(&newName); err != nil {
				logger.Info("invalid LLM JSON: %w", err)
				return nil, fmt.Errorf("invalid LLM JSON: %w", err)
			}
			updatedCart[idx].GeneratedName = newName.SuggestedName
			receiptLogger.Info("Updatd Title: ", updatedCart[idx].GeneratedName)
		}

		for idx := range updatedCart {
			logger.Info("New Names:", updatedCart[idx].GeneratedName)
		}

		settingsMutex.RLock()
		availableCategories := make([]string, 0, len(settings.SelectedReceiptCategories))
		for _, c := range settings.SelectedReceiptCategories {
			availableCategories = append(availableCategories, c.Name)
		}
		settingsMutex.RUnlock()

		updatedCart, err = app.vlmReceipts.ProcessReceiptCategories(ctx, updatedCart, availableCategories, receiptJobID)

		//app.vlmReceipts.ProcessReceiptCategories(ctx, updatedCart, availableCategories, receiptJobID)
		workReceipt.TaxCents = int(workReceipt.TotalTender) - subTotalCents

		pageLogger.WithFields(logrus.Fields{
			"total_tender_cents": int(workReceipt.TotalTender),
			"subtotal_cents":     subTotalCents,
			"tax_cents":          workReceipt.TaxCents,
		}).Info("Receipt totals")
		pageLogger.Info("Item OCR Complete for document %d, page %d, jobID %s", documentID, i+1, receiptJobID)
		var availablePayees []string
		var blockListPayess []string
		suggestedCorrespondent, err := app.getSuggestedCorrespondent(ctx, originalDocument.Content, "", availablePayees, blockListPayess)
		if err != nil {
			return nil, fmt.Errorf("error getting receipt correspondent: %w", err)
		}
		workReceipt.Payee = suggestedCorrespondent

		pageLogger.Info("Payee: ", workReceipt.Payee)

		workReceipt.Cart = updatedCart
		//ocrTexts = append(ocrTexts, result.Text)
		//ocrResults = append(ocrResults, result)
	}
	// generatedTitle, err := app.getSuggestedTitle(ctx, workReceipt.TradOCR, workReceipt.Title, receiptLogger)
	// if err != nil {
	// 	return nil, fmt.Errorf("error generating suggesting title")
	// }

	// workReceipt.Title = generatedTitle

	processedReceipt := workReceipt
	processedReceipt.TradOCR = originalDocument.Content

	return processedReceipt, nil

}
