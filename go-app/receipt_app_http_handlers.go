package main

import (
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
)

func (app *App) submitReceiptJobHandler(c *gin.Context) {
	documentIDStr := c.Param("id")
	documentID, err := strconv.Atoi(documentIDStr)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid document ID"})
		return
	}

	// Optional body allows client to pass documentId, totalTender, itemsSold
	type receiptJobRequest struct {
		DocumentID  int    `json:"documentId"`
		TotalTender int64  `json:"totalTender"`
		ItemsSold   int    `json:"itemsSold"`
		ReceiptDate string `json:"receiptDate"`
		BudgetID    string `json:"budgetId"`
		AccountID   string `json:"accountId"`
	}

	var req receiptJobRequest
	if err := c.ShouldBindJSON(&req); err != nil && err != io.EOF {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
		return
	}

	// If body includes a DocumentID, ensure it matches the path parameter (or use it when path is empty)
	if req.DocumentID == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no documentID"})
		return
	}
	if req.DocumentID != documentID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "documentId in body does not match path"})
		return
	}

	// Create a new receiptJob
	receiptJobID := generateReceiptJobID() // Implement a function to generate unique receiptJob IDs
	receiptJob := &ReceiptJob{
		ID:          receiptJobID,
		DocumentID:  documentID,
		TotalTender: req.TotalTender,
		ItemsSold:   req.ItemsSold,
		Date:        req.ReceiptDate,
		BudgetID:    req.BudgetID,
		AccountID:   req.AccountID,
		Status:      "pending",
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}

	// Add receiptJob to store and queue
	receiptJobStore.addReceiptJob(receiptJob)
	receiptJobQueue <- receiptJob

	// Return the receiptJob ID to the client
	c.JSON(http.StatusAccepted, gin.H{"receiptJob_id": receiptJobID})
}

func (app *App) getReceiptJobStatusHandler(c *gin.Context) {
	receiptJobID := c.Param("receiptJob_id")

	receiptJob, exists := receiptJobStore.getReceiptJob(receiptJobID)
	if !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "receiptJob not found"})
		return
	}

	response := gin.H{
		"receiptJob_id": receiptJob.ID,
		"status":        receiptJob.Status,
		"created_at":    receiptJob.CreatedAt,
		"updated_at":    receiptJob.UpdatedAt,
		"pages_done":    receiptJob.PagesDone,
		"total_pages":   receiptJob.TotalPages,
	}

	if receiptJob.Status == "completed" {
		response["result"] = receiptJob.Result
	} else if receiptJob.Status == "failed" {
		response["error"] = receiptJob.Result
	}

	c.JSON(http.StatusOK, response)
}

func (app *App) getAllReceiptJobsHandler(c *gin.Context) {
	receiptJobs := receiptJobStore.GetAllReceiptJobs()

	receiptJobList := make([]gin.H, 0, len(receiptJobs))
	for _, receiptJob := range receiptJobs {
		response := gin.H{
			"receiptJob_id": receiptJob.ID,
			"status":        receiptJob.Status,
			"created_at":    receiptJob.CreatedAt,
			"updated_at":    receiptJob.UpdatedAt,
			"pages_done":    receiptJob.PagesDone,
		}

		if receiptJob.Status == "completed" {
			response["result"] = receiptJob.Result
		} else if receiptJob.Status == "failed" {
			response["error"] = receiptJob.Result
		}

		receiptJobList = append(receiptJobList, response)
	}

	c.JSON(http.StatusOK, receiptJobList)
}

// POST /api/ocr/receiptJobs/:receiptJob_id/stop
func (app *App) stopReceiptJobHandler(c *gin.Context) {
	receiptJobID := c.Param("receiptJob_id")
	receiptJobCancellersMu.Lock()
	cancel, exists := receiptJobCancellers[receiptJobID]
	receiptJobCancellersMu.Unlock()
	if !exists {
		c.JSON(http.StatusNotFound, gin.H{"error": "No running receiptJob with this ID"})
		return
	}
	cancel()
	c.Status(http.StatusNoContent)
}
