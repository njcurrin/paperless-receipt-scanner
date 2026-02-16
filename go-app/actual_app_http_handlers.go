package main

import (
	"net/http"
	"paperless-gpt/actualClient"
	"sort"
	"strconv"
	"strings"
	"time"

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

func (app *App) getBudgetAccountTransactionsHandler(c *gin.Context) {
	ctx := c.Request.Context()

	if app.ActualClient == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Actual client not configured"})
		return
	}

	budgetID := strings.TrimSpace(c.Param("budgetId"))
	if budgetID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing budgetId"})
		return
	}

	accountID := strings.TrimSpace(c.Param("accountId"))
	if accountID == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "Missing accountId"})
		return
	}

	sinceDate := strings.TrimSpace(c.Query("since_date"))
	untilDate := strings.TrimSpace(c.Query("until_date"))

	if sinceDate == "" {
		days := 2
		if rawDays := strings.TrimSpace(c.Query("days")); rawDays != "" {
			parsedDays, err := strconv.Atoi(rawDays)
			if err != nil || parsedDays < 1 || parsedDays > 31 {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid days query; expected integer 1-31"})
				return
			}
			days = parsedDays
		}

		now := time.Now()
		untilDate = now.Format("2006-01-02")
		startOffsetDays := days - 1
		if startOffsetDays < 0 {
			startOffsetDays = 0
		}
		sinceDate = now.AddDate(0, 0, -startOffsetDays).Format("2006-01-02")
	} else if untilDate == "" {
		untilDate = time.Now().Format("2006-01-02")
	}

	transactions, err := app.ActualClient.GetAccountTransactions(ctx, budgetID, accountID, sinceDate, untilDate)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	sort.SliceStable(transactions, func(i, j int) bool {
		if transactions[i].Date == transactions[j].Date {
			return transactions[i].SortOrder > transactions[j].SortOrder
		}
		return transactions[i].Date > transactions[j].Date
	})

	c.JSON(http.StatusOK, transactions)
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
