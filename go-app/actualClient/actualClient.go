package actualClient

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/sirupsen/logrus"
)

var actualLogger = logrus.New()

type ActualClientInterface interface {
	GetBudgets(ctx context.Context) ([]Budget, error)
	GetBudgetCategories(ctx context.Context, budgetId string) ([]Category, error)
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

func (client *ActualClient) GetBudgetCategories(ctx context.Context, budgetId string) ([]Category, error) {
	if strings.TrimSpace(budgetId) == "" {
		return nil, fmt.Errorf("budgetId is required")
	}

	path := fmt.Sprintf("v1/budgets/%s/categories", url.PathEscape(budgetId))
	resp, err := client.Do(ctx, "GET", path, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	var dec CategoryResponse
	if err := json.NewDecoder(resp.Body).Decode(&dec); err != nil {
		return nil, err
	}

	categories := make([]Category, 0, len(dec.Data))
	for _, c := range dec.Data {
		if c.Hidden == true {
			continue
		}
		categories = append(categories, c)
	}

	return categories, nil
}
