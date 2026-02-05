package actualClient

type BudgetResponse struct {
	Data []Budget `json:"data"`
}
type CategoryResponse struct {
	Data []Category `json:"data"`
}

type Budget struct {
	GroupID string `json:"groupId,omitempty"`
	Name    string `json:"name,omitempty"`
	HasKey  *bool  `json:"hasKey,omitempty"`
}

type Category struct {
	ID      string `json:"id,omitempty"`
	GroupID string `json:"group_id,omitempty"`
	Name    string `json:"name,omitempty"`
	Income  bool   `json:"is_income,omitempty"`
	Hidden  bool   `json:"hidden,omitempty"`
}

type SelectedCategories struct {
	Categories []Category
}
