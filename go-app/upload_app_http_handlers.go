package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	uploadWaitInterval = 2 * time.Second
	uploadMaxWait      = 2 * time.Minute
)

// uploadDocumentHandler handles uploads from the UI and forwards them to Paperless.
// It waits for the Paperless task to complete and returns the created document ID.
func (app *App) uploadDocumentHandler(c *gin.Context) {
	ctx := c.Request.Context()

	fileHeader, err := c.FormFile("document")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing document file"})
		return
	}

	file, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Unable to read uploaded file"})
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Failed to read uploaded file"})
		return
	}

	filename := strings.TrimSpace(fileHeader.Filename)
	if filename == "" {
		filename = "upload"
	}
	filename = filepath.Base(filename)

	taskID, err := app.Client.UploadDocument(ctx, data, filename, map[string]interface{}{})
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": fmt.Sprintf("Upload failed: %v", err)})
		return
	}

	documentID, status, err := waitForTaskDocumentID(ctx, app.Client, taskID, uploadMaxWait)
	if err != nil {
		c.JSON(http.StatusGatewayTimeout, gin.H{
			"task_id": taskID,
			"status":  status,
			"error":   err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"task_id":     taskID,
		"document_id": documentID,
	})
}

func waitForTaskDocumentID(ctx context.Context, client ClientInterface, taskID string, maxWait time.Duration) (int, string, error) {
	deadline := time.Now().Add(maxWait)
	lastStatus := ""
	sawSuccessWithoutID := false

	for {
		if time.Now().After(deadline) {
			if sawSuccessWithoutID {
				return 0, lastStatus, fmt.Errorf("task completed but document_id was missing")
			}
			return 0, lastStatus, fmt.Errorf("timed out waiting for Paperless to finish processing")
		}

		taskStatus, err := client.GetTaskStatus(ctx, taskID)
		if err != nil {
			return 0, lastStatus, fmt.Errorf("failed to check task status: %w", err)
		}

		status, _ := taskStatus["status"].(string)
		if status != "" {
			lastStatus = status
		}
		switch status {
		case "SUCCESS":
			documentID, ok := extractTaskDocumentID(taskStatus)
			if !ok {
				sawSuccessWithoutID = true
				break
			}
			return documentID, status, nil
		case "FAILURE":
			return 0, status, fmt.Errorf("paperless task failed")
		}

		select {
		case <-ctx.Done():
			return 0, status, ctx.Err()
		case <-time.After(uploadWaitInterval):
		}
	}
}

func extractTaskDocumentID(taskStatus map[string]interface{}) (int, bool) {
	for _, key := range []string{"document_id", "documentId", "documentID", "document"} {
		if id, ok := parseIntValue(taskStatus[key]); ok {
			return id, true
		}
	}
	if id, ok := parseDocumentIDFromResult(taskStatus["result"]); ok {
		return id, true
	}
	if id, ok := parseDocumentIDFromResult(taskStatus["results"]); ok {
		return id, true
	}
	return 0, false
}

func parseDocumentIDFromResult(result interface{}) (int, bool) {
	switch value := result.(type) {
	case map[string]interface{}:
		for _, key := range []string{"document_id", "documentId", "documentID", "document", "id"} {
			if id, ok := parseIntValue(value[key]); ok {
				return id, true
			}
		}
		for _, key := range []string{"documents", "document_ids", "results", "result"} {
			if id, ok := parseDocumentIDFromResult(value[key]); ok {
				return id, true
			}
		}
	case []interface{}:
		for _, item := range value {
			if id, ok := parseDocumentIDFromResult(item); ok {
				return id, true
			}
		}
	case string:
		return parseDocumentIDFromString(value)
	}
	return 0, false
}

func parseDocumentIDFromString(value string) (int, bool) {
	if id, ok := parseIntValue(value); ok {
		return id, true
	}
	cleaned := strings.TrimSpace(value)
	if cleaned == "" {
		return 0, false
	}
	var parsed interface{}
	if err := json.Unmarshal([]byte(cleaned), &parsed); err == nil {
		if id, ok := parseDocumentIDFromResult(parsed); ok {
			return id, true
		}
	}
	lower := strings.ToLower(cleaned)
	if !strings.Contains(lower, "document") {
		return 0, false
	}
	re := regexp.MustCompile(`\d+`)
	if match := re.FindString(cleaned); match != "" {
		if id, err := strconv.Atoi(match); err == nil {
			return id, true
		}
	}
	return 0, false
}

func parseIntValue(value interface{}) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	case float32:
		return int(v), true
	case json.Number:
		if i, err := v.Int64(); err == nil {
			return int(i), true
		}
		if f, err := v.Float64(); err == nil {
			return int(f), true
		}
	case string:
		trimmed := strings.TrimSpace(v)
		if trimmed == "" {
			return 0, false
		}
		if i, err := strconv.Atoi(trimmed); err == nil {
			return i, true
		}
	}
	return 0, false
}
