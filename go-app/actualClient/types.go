package actualClient

type BudgetResponse struct {
	Data []Budget `json:"data"`
}
type CategoryGroupResponse struct {
	Data []CategoryGroup `json:"data"`
}

type Budget struct {
	GroupID string `json:"groupId"`
	Name    string `json:"name"`
	HasKey  *bool  `json:"hasKey"`
}

type Category struct {
	ID      string `json:"id"`
	GroupID string `json:"group_id"`
	Name    string `json:"name"`
	Income  bool   `json:"is_income"`
	Hidden  bool   `json:"hidden"`
}

type CategoryGroup struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Income     bool       `json:"is_income"`
	Hidden     bool       `json:"hidden"`
	Categories []Category `json:"categories"`
}

type SelectedCategories struct {
	Categories []Category
}

type Account struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	OffBudget bool   `json:"offBudget"`
	Closed    bool   `json:"closed"`
}

type AccountResponse struct {
	Data []Account `json:"data"`
}

type Transaction struct {
	ID              string            `json:"id"`
	ParentId        *string           `json:"parent_id"`
	IsChild         bool              `json:"is_child"`
	IsParent        bool              `json:"is_parent"`
	ImportedId      *string           `json:"imported_id"`
	TransferId      *string           `json:"transfer_id"`
	AccountId       string            `json:"account"`
	Category        *string           `json:"category"`
	Amount          int               `json:"amount"`
	PayeeId         string            `json:"payee"`
	Notes           string            `json:"notes"`
	Date            string            `json:"date"`
	ImportedPayee   *string           `json:"imported_payee"`
	SortOrder       int64             `json:"sort_order"`
	Cleared         bool              `json:"cleared"`
	SubTransactions []TransactionItem `json:"subtransactions"`
}

type TransactionResponse struct {
	Data []Transaction `json:"data"`
}

type TransactionItem struct {
	Amount   int    `json:"amount"`
	Category string `json:"category"`
	Notes    string `json:"notes"`
}
