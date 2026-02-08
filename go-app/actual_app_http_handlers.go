package main

import (
	"net/http"
	"paperless-gpt/actualClient"
	"strings"

	"github.com/gin-gonic/gin"
)

type saveSelectedBudgetCategoriesRequest struct {
	Categories []actualClient.Category `json:"categories"`
}

func (app *App) getBudgetsHandler(c *gin.Context) {
	ctx := c.Request.Context()

	if app.ActualClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Actual client not configured"})
		return
	}

	budgets, err := app.ActualClient.GetBudgets(ctx)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, budgets)
}

func (app *App) getBudgetCategoriesHandler(c *gin.Context) {
	ctx := c.Request.Context()

	if app.ActualClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Actual client not configured"})
		return
	}

	budgetID := c.Param("budgetId")
	if budgetID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing budgetId"})
		return
	}

	categories, err := app.ActualClient.GetBudgetCategories(ctx, budgetID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, categories)
}

func (app *App) saveBudgetCategoriesHandler(c *gin.Context) {
	budgetID := strings.TrimSpace(c.Param("budgetId"))
	if budgetID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing budgetId"})
		return
	}
	var req saveSelectedBudgetCategoriesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON payload"})
		return
	}
	if len(req.Categories) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "No categories provided"})
		return
	}

	log.Infof("budget_id=%s selected_categories_count=%d", budgetID, len(req.Categories))
	for _, cat := range req.Categories {
		log.Infof(
			"selected_category budget_id=%s category_id=%s category_name=%q group_id=%s",
			budgetID, cat.ID, cat.Name, cat.GroupID,
		)
	}
	settingsMutex.Lock()
	settings.SelectedReceiptCategories = req.Categories
	_ = saveSettingsLocked()
	settingsMutex.Unlock()

	c.JSON(http.StatusOK, gin.H{
		"budgetId": budgetID,
		"saved":    len(req.Categories),
	})
}

func (app *App) getBudgetAccountsHandler(c *gin.Context) {
	ctx := c.Request.Context()

	if app.ActualClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Actual client not configured"})
		return
	}

	budgetID := c.Param("budgetId")
	if budgetID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing budgetId"})
		return
	}

	accounts, err := app.ActualClient.GetBudgetAccounts(ctx, budgetID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, accounts)
}

func (app *App) postActualTransaction(c *gin.Context) {
	budgetID := strings.TrimSpace(c.Param("budgetId"))
	if budgetID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing budgetId"})
		return
	}
	transactionID := strings.TrimSpace(c.Param("transactionId"))
	if transactionID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing transactionId"})
		return
	}

	if app.ActualClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Actual client not configured"})
		return
	}

	var tx actualClient.Transaction
	if err := c.ShouldBindJSON(&tx); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid JSON payload"})
		return
	}

	if strings.TrimSpace(tx.ID) == "" {
		tx.ID = transactionID
	} else if tx.ID != transactionID {
		c.JSON(http.StatusBadRequest, gin.H{"error": "transactionId in body does not match path"})
		return
	}

	accountID := strings.TrimSpace(tx.AccountId)
	if err := app.ActualClient.UpdateTransaction(c.Request.Context(), budgetID, accountID, &tx); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"updated": tx.ID,
	})
}
