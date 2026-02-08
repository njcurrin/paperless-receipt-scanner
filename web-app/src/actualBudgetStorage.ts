const ACTUAL_BUDGET_ID_STORAGE_KEY = "paperlessgpt.actual.budgetId";

export const readActualBudgetId = (): string => {
  if (typeof window === "undefined") return "";
  return window.localStorage.getItem(ACTUAL_BUDGET_ID_STORAGE_KEY) ?? "";
};

export const writeActualBudgetId = (value: string): void => {
  if (typeof window === "undefined") return;
  const trimmed = value.trim();
  if (trimmed) {
    window.localStorage.setItem(ACTUAL_BUDGET_ID_STORAGE_KEY, trimmed);
  } else {
    window.localStorage.removeItem(ACTUAL_BUDGET_ID_STORAGE_KEY);
  }
};
