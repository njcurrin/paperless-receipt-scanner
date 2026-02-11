package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"paperless-gpt/local_db"

	"github.com/google/uuid"
	"github.com/sirupsen/logrus"
)

var (
	receiptJobCancellersMu sync.Mutex
	receiptJobCancellers   = make(map[string]context.CancelFunc)

	reReceiptCancellersMu sync.Mutex
	reReceiptCancellers   = make(map[string]context.CancelFunc)
)

// ReceiptJob represents an Receipt job
type ReceiptJob struct {
	ID          string
	DocumentID  int
	TotalTender int64
	ItemsSold   int
	Date        string
	BudgetID    string
	AccountID   string
	Status      string // "pending", "in_progress", "completed", "failed", "cancelled"
	Result      string // Receipt result (combined text) or error message
	CreatedAt   time.Time
	UpdatedAt   time.Time
	PagesDone   int            // Number of pages processed
	TotalPages  int            // Total number of pages in the document
	Options     ReceiptOptions // Receipt processing options
}

type receiptResultItem struct {
	Title         string `json:"title"`
	GeneratedName string `json:"generatedName"`
	Cost          int    `json:"cost"`
	Category      string `json:"category"`
}

type receiptJobTransactionPayload struct {
	ID            string  `json:"id"`
	ParentId      *string `json:"parent_id"`
	AccountId     string  `json:"account"`
	Category      *string `json:"category"`
	Amount        int     `json:"amount"`
	Payee         string  `json:"payee"`
	Notes         string  `json:"notes,omitempty"`
	Date          string  `json:"date"`
	ImportedPayee *string `json:"imported_payee"`
	TransferId    *string `json:"transfer_id"`
	SortOrder     int64   `json:"sort_order"`
	Cleared       bool    `json:"cleared"`
}

type receiptJobResultPayload struct {
	PromptName         string                        `json:"promptName"`
	CombinedText       string                        `json:"combinedText,omitempty"`
	Payee              string                        `json:"payee,omitempty"`
	Cart               []receiptResultItem           `json:"cart"`
	TaxCents           int                           `json:"taxCents,omitempty"`
	MatchedTransaction *receiptJobTransactionPayload `json:"matchedTransaction,omitempty"`
	TransactionError   string                        `json:"transactionError,omitempty"`
}

// ReceiptJobStore manages jobs and their statuses
type ReceiptJobStore struct {
	sync.RWMutex
	receiptJobs map[string]*ReceiptJob
}

var (
	receiptLogger = logrus.New()

	receiptJobStore = &ReceiptJobStore{
		receiptJobs: make(map[string]*ReceiptJob),
	}
	receiptJobQueue = make(chan *ReceiptJob, 100) // Buffered channel with capacity of 100 jobs
)

func init() {

	// Initialize receiptLogger
	receiptLogger.SetOutput(os.Stdout)
	receiptLogger.SetFormatter(&logrus.TextFormatter{
		FullTimestamp: true,
	})
	receiptLogger.SetLevel(logrus.InfoLevel)
	receiptLogger.WithField("prefix", "RECEIPT_JOB")
}

func generateReceiptJobID() string {
	receiptJobID := uuid.New().String()
	receiptLogger.Info("Receipt Job ID: ", receiptJobID)
	return receiptJobID
}

func (store *ReceiptJobStore) addReceiptJob(receiptJob *ReceiptJob) {
	store.Lock()
	defer store.Unlock()
	receiptJob.PagesDone = 0 // Initialize PagesDone to 0
	store.receiptJobs[receiptJob.ID] = receiptJob
	receiptLogger.Infof("ReceiptJob added: %v", receiptJob)
}

func (store *ReceiptJobStore) getReceiptJob(receiptJobID string) (*ReceiptJob, bool) {
	store.RLock()
	defer store.RUnlock()
	receiptJob, exists := store.receiptJobs[receiptJobID]
	return receiptJob, exists
}

func (store *ReceiptJobStore) GetAllReceiptJobs() []*ReceiptJob {
	store.RLock()
	defer store.RUnlock()

	receiptJobs := make([]*ReceiptJob, 0, len(store.receiptJobs))
	for _, receiptJob := range store.receiptJobs {
		receiptJobs = append(receiptJobs, receiptJob)
	}

	sort.Slice(receiptJobs, func(i, j int) bool {
		return receiptJobs[i].CreatedAt.After(receiptJobs[j].CreatedAt)
	})

	return receiptJobs
}

func (store *ReceiptJobStore) updateReceiptJobStatus(receiptJobID, status, result string) {
	store.Lock()
	defer store.Unlock()
	if receiptJob, exists := store.receiptJobs[receiptJobID]; exists {
		receiptJob.Status = status
		if result != "" {
			receiptJob.Result = result
		}
		receiptJob.UpdatedAt = time.Now()
		//receiptLogger.Infof("ReceiptJob status updated: %v", job)
		receiptLogger.Infof("ReceiptJob status updated")
	}
}

func (store *ReceiptJobStore) updatePagesDone(receiptJobID string, pagesDone int) {
	store.Lock()
	defer store.Unlock()
	if receiptJob, exists := store.receiptJobs[receiptJobID]; exists {
		receiptJob.PagesDone = pagesDone
		receiptJob.UpdatedAt = time.Now()
		receiptLogger.Infof("ReceiptJob pages done updated: %v", receiptJob)
	}
}

func startReceiptWorkerPool(app *App, numWorkers int) {
	for i := 0; i < numWorkers; i++ {
		go func(workerID int) {
			receiptLogger.Infof("ReceiptWorker %d started", workerID)
			for receiptJob := range receiptJobQueue {
				receiptLogger.Infof("ReceiptWorker %d processing receiptJob: %s", workerID, receiptJob.ID)
				processReceiptJob(app, receiptJob)
			}
		}(i)
	}
}

func processReceiptJob(app *App, receiptJob *ReceiptJob) {
	// Pre-Flight checklist for ProcessReceipt()
	// 	Update Status
	// 	Create Context
	// 	Cancel Mechanism
	// 	Database initialization
	//		Delete previous OCR Job data
	// 		populate read-Only TotalTender, ItemsSold
	//		Populate Default ReceiptJobOptions if unset by user
	// Flight
	// 	pass pre-flight data to ProcessReceipt(ctx, receiptJob.DocumentID, TotalTender, ItemsSold, options, receiptJob.ID)
	// 	log early cancellation by user
	// 	log errors
	// 	ProcessReceipt() finished

	// Landing
	// 	update job status to completed
	// 	log completion
	receiptLogger.SetOutput(os.Stdout)
	receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "in_progress", "")

	receiptJobCtx, cancel := context.WithCancel(context.Background())
	receiptJobCancellersMu.Lock()
	receiptJobCancellers[receiptJob.ID] = cancel
	receiptJobCancellersMu.Unlock()
	defer func() {
		cancel()
		receiptJobCancellersMu.Lock()
		delete(receiptJobCancellers, receiptJob.ID)
		receiptJobCancellersMu.Unlock()
	}()

	// Delete old Receipt page results for this document before starting new Receipt
	if err := local_db.DeleteOcrPageResults(app.Database, receiptJob.DocumentID); err != nil {
		receiptLogger.Errorf("Failed to delete old Receipt page results for document %d: %v", receiptJob.DocumentID, err)
		// Continue processing even if deletion fails
	}

	// Create Receipt options from receiptJob options or app defaults
	options := receiptJob.Options
	if (options == ReceiptOptions{}) {
		// Use app defaults if receiptJob options are not set
		options = ReceiptOptions{
			UploadPDF:       app.pdfUpload,
			ReplaceOriginal: app.pdfReplace,
			CopyMetadata:    app.pdfCopyMetadata,
			LimitPages:      limitOcrPages,
		}
	}

	//processedDoc, err := app.ProcessDocumentOCR(receiptJobCtx, receiptJob.DocumentID, options, receiptJob.ID)
	// if err != nil {
	// 	if receiptJobCtx.Err() == context.Canceled {
	// 		receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "cancelled", "ReceiptJob cancelled by user")
	// 		receiptLogger.Infof("ReceiptJob cancelled: %s", receiptJob.ID)
	// 	} else {
	// 		receiptLogger.Errorf("Error processing document Receipt for receiptJob %s: %v", receiptJob.ID, err)
	// 		receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "failed", err.Error())
	// 	}
	// 	return
	// }
	// if processedDoc == nil {
	// 	receiptLogger.Infof("Receipt processing skipped for receiptJob %s (document %d)", receiptJob.ID, receiptJob.DocumentID)
	// 	receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "completed", "Skipped (already processed or other reason)")
	// 	return
	// }
	receiptLogger.Info("Hello There!")

	document, err := app.Client.GetDocument(receiptJobCtx, receiptJob.DocumentID)
	if err != nil {
		receiptLogger.Errorf("Error fetching document for receiptJob %s: %v", receiptJob.ID, err)
		receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "failed", err.Error())
		return
	}

	fieldTypes := getCustomFieldTypeLookup(app.Client)
	totalTenderCents, itemsSold, err := extractReceiptCustomFields(document, fieldTypes)
	if err != nil {
		receiptLogger.Errorf("Missing/invalid receipt custom fields for receiptJob %s: %v", receiptJob.ID, err)
		receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "failed", err.Error())
		return
	}

	receiptJob.TotalTender = totalTenderCents
	receiptJob.ItemsSold = itemsSold

	receiptTotalTender := receiptJob.TotalTender
	if receiptTotalTender < 0 {
		receiptTotalTender = -receiptTotalTender
	}

	processedReceipt, err := app.processReceipt(
		receiptJobCtx,
		receiptJob.DocumentID,
		receiptTotalTender,
		receiptJob.ItemsSold,
		receiptJob.Date,
		options,
		receiptJob.ID,
	)
	if err != nil {
		if receiptJobCtx.Err() == context.Canceled {
			receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "cancelled", "ReceiptJob cancelled by user")
			receiptLogger.Infof("ReceiptJob cancelled: %s", receiptJob.ID)
		} else {
			receiptLogger.Errorf("Error processing document Receipt for receiptJob %s: %v", receiptJob.ID, err)
			receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "failed", err.Error())
		}
		return
	}
	if processedReceipt == nil {
		receiptLogger.Infof("Receipt processing skipped for receiptJob %s (document %d)", receiptJob.ID, receiptJob.DocumentID)
		receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "completed", "Skipped (already processed or other reason)")
		return
	}

	cartItems := make([]receiptResultItem, 0, len(processedReceipt.Cart))
	for _, cartItem := range processedReceipt.Cart {
		cartItems = append(cartItems, receiptResultItem{
			Title:         cartItem.Title,
			GeneratedName: cartItem.GeneratedName,
			Cost:          cartItem.Cost,
			Category:      cartItem.Category,
		})
		receiptLogger.Info("Result Category: ", cartItem.Category)
	}

	var matchedTransaction *receiptJobTransactionPayload
	var transactionError string
	if app.ActualClient == nil {
		transactionError = "Actual client not configured"
	} else if receiptJob.BudgetID == "" || receiptJob.AccountID == "" || receiptJob.Date == "" || receiptJob.TotalTender == 0 {
		transactionError = "transaction match skipped: missing budgetId, accountId, receipt date, or amount"
	} else {
		tx, err := app.ActualClient.FindTransactionByDateAndAmount(
			receiptJobCtx,
			receiptJob.BudgetID,
			receiptJob.AccountID,
			receiptJob.Date,
			int(receiptJob.TotalTender),
		)
		if err != nil {
			transactionError = err.Error()
			receiptLogger.WithError(err).Warn("Failed to match transaction")
		} else if tx != nil {
			matchedTransaction = &receiptJobTransactionPayload{
				ID:            tx.ID,
				ParentId:      tx.ParentId,
				AccountId:     tx.AccountId,
				Category:      tx.Category,
				Amount:        tx.Amount,
				Payee:         tx.PayeeId,
				Notes:         tx.Notes,
				Date:          tx.Date,
				ImportedPayee: tx.ImportedPayee,
				TransferId:    tx.TransferId,
				SortOrder:     tx.SortOrder,
				Cleared:       tx.Cleared,
			}
		}
	}

	resultPayload := receiptJobResultPayload{
		PromptName:         "receipt_cart_prompt",
		CombinedText:       processedReceipt.TradOCR,
		Payee:              processedReceipt.Payee,
		Cart:               cartItems,
		TaxCents:           processedReceipt.TaxCents,
		MatchedTransaction: matchedTransaction,
		TransactionError:   transactionError,
	}
	resultJSON, err := json.Marshal(resultPayload)
	if err != nil {
		receiptLogger.Errorf("Failed to marshal receipt result for receiptJob %s: %v", receiptJob.ID, err)
		receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "failed", "Failed to serialize receipt results")
		return
	}

	receiptJobStore.updateReceiptJobStatus(receiptJob.ID, "completed", string(resultJSON))
	receiptLogger.Infof("ReceiptJob completed: %s", receiptJob.ID)
}

func extractReceiptCustomFields(document Document, fieldTypes map[int]string) (int64, int, error) {
	var totalTenderValue *float64
	var totalTenderCents *int64
	var itemsSoldValue *int

	for _, cf := range document.CustomFields {
		name := strings.TrimSpace(strings.ToLower(cf.Name))
		switch name {
		case "totaltender":
			fieldType := strings.TrimSpace(strings.ToLower(fieldTypes[cf.Field]))
			if fieldType == "integer" || fieldType == "int" {
				value, err := parseCustomFieldInt(cf.Value)
				if err != nil {
					return 0, 0, fmt.Errorf("invalid totalTender custom field: %w", err)
				}
				if value != 0 {
					normalized := int64(value)
					totalTenderCents = &normalized
				}
				break
			}
			value, err := parseCustomFieldNumber(cf.Value)
			if err != nil {
				return 0, 0, fmt.Errorf("invalid totalTender custom field: %w", err)
			}
			if value != 0 {
				totalTenderValue = &value
			}
		case "itemssold":
			value, err := parseCustomFieldInt(cf.Value)
			if err != nil {
				return 0, 0, fmt.Errorf("invalid itemsSold custom field: %w", err)
			}
			if value > 0 {
				itemsSoldValue = &value
			}
		}
	}

	missing := []string{}
	if totalTenderCents == nil && (totalTenderValue == nil || *totalTenderValue == 0) {
		missing = append(missing, "totalTender")
	}
	if itemsSoldValue == nil || *itemsSoldValue <= 0 {
		missing = append(missing, "itemsSold")
	}
	if len(missing) > 0 {
		return 0, 0, fmt.Errorf("missing or invalid custom fields: %s", strings.Join(missing, ", "))
	}

	if totalTenderCents != nil {
		return *totalTenderCents, *itemsSoldValue, nil
	}

	cents := int64(math.Round(*totalTenderValue * 100))

	return cents, *itemsSoldValue, nil
}

func getCustomFieldTypeLookup(client ClientInterface) map[int]string {
	customFieldsCacheMu.RLock()
	fields := append([]local_db.CustomField(nil), customFieldsCache...)
	customFieldsCacheMu.RUnlock()

	if len(fields) == 0 {
		refreshCustomFieldsCache(client)
		customFieldsCacheMu.RLock()
		fields = append([]local_db.CustomField(nil), customFieldsCache...)
		customFieldsCacheMu.RUnlock()
	}

	lookup := make(map[int]string, len(fields))
	for _, field := range fields {
		lookup[field.ID] = strings.TrimSpace(strings.ToLower(field.DataType))
	}
	return lookup
}

func parseCustomFieldNumber(value interface{}) (float64, error) {
	switch v := value.(type) {
	case float64:
		return v, nil
	case float32:
		return float64(v), nil
	case int:
		return float64(v), nil
	case int64:
		return float64(v), nil
	case json.Number:
		return v.Float64()
	case string:
		cleaned := strings.TrimSpace(v)
		cleaned = strings.TrimPrefix(cleaned, "$")
		cleaned = strings.ReplaceAll(cleaned, ",", "")
		if cleaned == "" {
			return 0, fmt.Errorf("empty string")
		}
		return strconv.ParseFloat(cleaned, 64)
	default:
		return 0, fmt.Errorf("unsupported type %T", value)
	}
}

func parseCustomFieldInt(value interface{}) (int, error) {
	switch v := value.(type) {
	case int:
		return v, nil
	case int64:
		return int(v), nil
	case float64:
		return int(math.Round(v)), nil
	case float32:
		return int(math.Round(float64(v))), nil
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return int(i), nil
		}
		if f, err := v.Float64(); err == nil {
			return int(math.Round(f)), nil
		}
		return 0, fmt.Errorf("invalid json number")
	case string:
		cleaned := strings.TrimSpace(v)
		if cleaned == "" {
			return 0, fmt.Errorf("empty string")
		}
		if i, err := strconv.Atoi(cleaned); err == nil {
			return i, nil
		}
		if f, err := strconv.ParseFloat(cleaned, 64); err == nil {
			return int(math.Round(f)), nil
		}
		return 0, fmt.Errorf("invalid string")
	default:
		return 0, fmt.Errorf("unsupported type %T", value)
	}
}
