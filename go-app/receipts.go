package main

import (
	"context"
	//"encoding/json"
	"net/http"
	//"fmt"
	//"os"
	//"path/filepath"
	//"strings"
	"strconv"
	//"time"

	//"paperless-gpt/ocr"

	//"github.com/gardar/ocrchestra/pkg/hocr"
	//"github.com/gardar/ocrchestra/pkg/pdfocr"
	//"github.com/sirupsen/logrus"
	"github.com/gin-gonic/gin"
)


// processReceiptHandler runs OCR in "receipt_scanner" mode for a document.
func (app *App) processReceiptHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := strconv.Atoi(c.Param("id"))
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid document id"})
			return
		}

		res, err := app.ProcessDocumentOCR(
			context.Background(),
			id,
			OCROptions{
				ProcessMode: "receipt_scanner", // uses receipt-specific prompt in ocr/llm_provider.go
				UploadPDF:   false,             // tweak as needed
			},
			"", // no job id
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"id":    res.ID,
			"text":  res.Text,
			"hocr":  res.HOCR,
			"pdf":   res.PDFData,
			"pages": res.HOCRStruct,
		})
	}
}

// registerReceiptRoutes attaches the receipt endpoint under /api.
func registerReceiptRoutes(api *gin.RouterGroup, app *App) {
	api.POST("/receipts/:id/scan", app.processReceiptHandler())
}
