package actualClient

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/sirupsen/logrus"
)

var actualLogger = logrus.New()

type ActualClientInterface interface {
	GetBudgets(ctx context.Context) ([]Budget, error)
	GetBudgetCategories(ctx context.Context, budgetId string) ([]CategoryGroup, error)
	GetBudgetAccounts(ctx context.Context, budgetId string) ([]Account, error)
	GetAccountTransactions(ctx context.Context, budgetId string, accountId string, startDate string, endDate string) ([]Transaction, error)
	FindTransactionByDateAndAmount(ctx context.Context, budgetId string, accountId string, date string, amount int) (*Transaction, error)
	UpdateTransaction(ctx context.Context, budgetId string, accountId string, transaction *Transaction) error
}

type ActualClient struct {
	BaseURL    string
	APIToken   string
	HTTPClient *http.Client
}

func NewActualClient(baseURL, apiToken string) *ActualClient {

	tr := &http.Transport{
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true,
		},
	}
	httpClient := &http.Client{Transport: tr}

	return &ActualClient{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		APIToken:   apiToken,
		HTTPClient: httpClient,
	}
}

func (client *ActualClient) Do(ctx context.Context, method, path string, body io.Reader) (*http.Response, error) {
	url := fmt.Sprintf("%s/%s", client.BaseURL, strings.TrimLeft(path, "/"))
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", client.APIToken)

	// Set Content-Type if body is present
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	actualLogger.WithFields(logrus.Fields{
		"method": method,
		"url":    url,
	}).Info("Making Http request to actual api")

	resp, err := client.HTTPClient.Do(req)
	if err != nil {
		actualLogger.WithError(err).WithFields(logrus.Fields{
			"url":    url,
			"method": method,
			"error":  err,
		}).Error("HTTP request failed")
		return nil, fmt.Errorf("HTTP request failed: %w", err)
	}

	//check for bad status codes and log
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("actual-http-api %s %s: status=%s body=%s", method, path, resp.Status, string(b))
	}
	if strings.HasPrefix(path, "api/") {
		contentType := resp.Header.Get("Content-Type")
		if strings.Contains(contentType, "text/html") {
			bodyBytes, _ := io.ReadAll(resp.Body)
			resp.Body.Close()

			actualLogger.WithFields(logrus.Fields{
				"url":          url,
				"method":       method,
				"content-type": contentType,
				"status-code":  resp.StatusCode,
				"response":     string(bodyBytes),
				"base-url":     client.BaseURL,
				"request-path": path,
				"full-headers": resp.Header,
			}).Error("Received HTML response for API request")

			return nil, fmt.Errorf("received HTML response instead of JSON (status: %d). This often indicates an SSL/TLS issue or invalid authentication. Check your Actual API URL, API token, and TLS settings. Full response: %s", resp.StatusCode, string(bodyBytes))
		}
	}

	return resp, nil
}

func (client *ActualClient) GetBudgets(ctx context.Context) ([]Budget, error) {
	resp, err := client.Do(ctx, "GET", "v1/budgets", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var dec BudgetResponse
	if err := json.NewDecoder(resp.Body).Decode(&dec); err != nil {
		return nil, err
	}

	budgets := make([]Budget, 0, len(dec.Data))

	for _, b := range dec.Data {
		if b.HasKey == nil {
			continue
		}
		budgets = append(budgets, b)
	}

	return budgets, nil

}

func (client *ActualClient) GetBudgetCategories(ctx context.Context, budgetId string) ([]CategoryGroup, error) {
	if strings.TrimSpace(budgetId) == "" {
		return nil, fmt.Errorf("budgetId is required")
	}

	path := fmt.Sprintf("v1/budgets/%s/categorygroups", url.PathEscape(budgetId))
	resp, err := client.Do(ctx, "GET", path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var dec CategoryGroupResponse
	if err := json.NewDecoder(resp.Body).Decode(&dec); err != nil {
		return nil, err
	}
	categories := make([]CategoryGroup, 0, len(dec.Data))
	for _, c := range dec.Data {
		if c.Hidden == true {
			continue
		}
		categories = append(categories, c)
	}

	return categories, nil
}

func (client *ActualClient) GetBudgetAccounts(ctx context.Context, budgetId string) ([]Account, error) {
	if strings.TrimSpace(budgetId) == "" {
		return nil, fmt.Errorf("budgetId is required")
	}

	path := fmt.Sprintf("v1/budgets/%s/accounts", url.PathEscape(budgetId))
	resp, err := client.Do(ctx, "GET", path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var dec AccountResponse
	if err := json.NewDecoder(resp.Body).Decode(&dec); err != nil {
		return nil, err
	}

	accounts := make([]Account, 0, len(dec.Data))
	for _, a := range dec.Data {
		if a.Closed == true || a.OffBudget == true {
			continue
		}
		accounts = append(accounts, a)
	}

	return accounts, nil
}

func (client *ActualClient) GetAccountTransactions(ctx context.Context, budgetId string, accountId string, startDate string, endDate string) ([]Transaction, error) {
	var path string
	if strings.TrimSpace(budgetId) == "" {
		return nil, fmt.Errorf("budgetId is required")
	}
	if strings.TrimSpace(accountId) == "" {
		return nil, fmt.Errorf("accountId is required")
	}
	if strings.TrimSpace(startDate) == "" {
		return nil, fmt.Errorf("startDate is required")
	}
	if strings.TrimSpace(endDate) != "" {
		path = fmt.Sprintf(
			"v1/budgets/%s/accounts/%s/transactions?since_date=%s&until_date=%s",
			url.PathEscape(budgetId),
			url.PathEscape(accountId),
			url.PathEscape(startDate),
			url.PathEscape(endDate))
	} else {
		path = fmt.Sprintf(
			"v1/budgets/%s/accounts/%s/transactions?since_date=%s",
			url.PathEscape(budgetId),
			url.PathEscape(accountId),
			url.PathEscape(startDate))
	}

	resp, err := client.Do(ctx, "GET", path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var dec TransactionResponse
	if err := json.NewDecoder(resp.Body).Decode(&dec); err != nil {
		return nil, err
	}

	transactions := make([]Transaction, 0, len(dec.Data))
	for _, t := range dec.Data {
		if t.IsChild == true {
			continue
		}
		transactions = append(transactions, t)
	}

	return transactions, nil
}

func (client *ActualClient) FindTransactionByDateAndAmount(ctx context.Context, budgetId string, accountId string, date string, amount int) (*Transaction, error) {
	var startDate string
	var endDate string
	if strings.TrimSpace(budgetId) == "" {
		return nil, fmt.Errorf("budgetId is required")
	}
	if strings.TrimSpace(accountId) == "" {
		return nil, fmt.Errorf("accountId is required")
	}
	if strings.TrimSpace(date) == "" {
		return nil, fmt.Errorf("date is required")
	}
	if amount == 0 {
		return nil, fmt.Errorf("amount is required")
	}

	startDate = date

	d, err := time.Parse("2006-01-02", date)
	if err != nil {
		return nil, fmt.Errorf("invalid date: %w", err)
	}
	d = d.AddDate(0, 0, 5)

	endDate = d.Format("2006-01-02")
	transactions, err := client.GetAccountTransactions(ctx, budgetId, accountId, startDate, endDate)
	if err != nil {
		return nil, err
	}
	var filtered []Transaction
	for _, t := range transactions {
		actualLogger.Info("transaction amount: " + strconv.Itoa(t.Amount) + " input amount: " + strconv.Itoa(amount))
		if t.Amount == amount {
			actualLogger.Info(amount)
			filtered = append(filtered, t)
		}

	}

	if len(filtered) == 0 {
		return nil, fmt.Errorf("no transactions found in date range")
	}
	if len(filtered) > 1 {
		return nil, fmt.Errorf("more than one transaction in date range")
	}

	transaction := filtered[0]
	return &transaction, nil

}

func (client *ActualClient) UpdateTransaction(ctx context.Context, budgetId string, accountId string, transaction *Transaction) error {
	if transaction == nil {
		return fmt.Errorf("transaction is required")
	}
	if strings.TrimSpace(budgetId) == "" {
		return fmt.Errorf("budgetId is required")
	}
	if strings.TrimSpace(transaction.ID) == "" {
		return fmt.Errorf("transaction id is required")
	}

	pathAccountId := strings.TrimSpace(accountId)
	if pathAccountId == "" {
		pathAccountId = strings.TrimSpace(transaction.AccountId)
	}
	if strings.TrimSpace(transaction.AccountId) == "" && pathAccountId == "" {
		return fmt.Errorf("accountId is required")
	}

	normalizeOptionalString := func(value *string) *string {
		if value == nil {
			return nil
		}
		if strings.TrimSpace(*value) == "" {
			return nil
		}
		return value
	}

	deletePath := fmt.Sprintf(
		"v1/budgets/%s/transactions/%s",
		url.PathEscape(budgetId),
		url.PathEscape(transaction.ID),
	)
	deleteResp, err := client.Do(ctx, "DELETE", deletePath, nil)
	if err != nil {
		return err
	}
	deleteResp.Body.Close()

	type createTransactionPayload struct {
		AccountId       string            `json:"account"`
		Category        *string           `json:"category,omitempty"`
		Amount          int               `json:"amount"`
		PayeeId         string            `json:"payee,omitempty"`
		Notes           string            `json:"notes,omitempty"`
		Date            string            `json:"date"`
		ImportedId      *string           `json:"imported_id,omitempty"`
		ImportedPayee   *string           `json:"imported_payee,omitempty"`
		TransferId      *string           `json:"transfer_id,omitempty"`
		SortOrder       int64             `json:"sort_order"`
		Cleared         bool              `json:"cleared"`
		SubTransactions []TransactionItem `json:"subtransactions,omitempty"`
	}

	type createTransactionRequest struct {
		Transaction     createTransactionPayload `json:"transaction"`
		LearnCategories bool                     `json:"learnCategories"`
		RunTransfers    bool                     `json:"runTransfers"`
	}

	payload := createTransactionPayload{
		AccountId:       pathAccountId,
		Category:        normalizeOptionalString(transaction.Category),
		Amount:          transaction.Amount,
		PayeeId:         transaction.PayeeId,
		Notes:           transaction.Notes,
		Date:            transaction.Date,
		ImportedId:      normalizeOptionalString(transaction.ImportedId),
		ImportedPayee:   normalizeOptionalString(transaction.ImportedPayee),
		TransferId:      normalizeOptionalString(transaction.TransferId),
		SortOrder:       transaction.SortOrder,
		Cleared:         transaction.Cleared,
		SubTransactions: transaction.SubTransactions,
	}

	if len(payload.SubTransactions) == 0 {
		actualLogger.Info("payload subtransactions: empty")
	} else {
		for idx, item := range payload.SubTransactions {
			actualLogger.WithFields(logrus.Fields{
				"index":    idx,
				"amount":   item.Amount,
				"category": item.Category,
				"notes":    item.Notes,
			}).Info("payload subtransaction")
		}
	}
	reqBody := createTransactionRequest{
		Transaction:     payload,
		LearnCategories: false,
		RunTransfers:    false,
	}

	body, err := json.Marshal(&reqBody)
	if err != nil {
		return fmt.Errorf("failed to marshal transaction: %w", err)
	}

	var path string
	path = fmt.Sprintf(
		"v1/budgets/%s/accounts/%s/transactions",
		url.PathEscape(budgetId),
		url.PathEscape(pathAccountId),
	)

	resp, err := client.Do(ctx, "POST", path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	return nil
}
