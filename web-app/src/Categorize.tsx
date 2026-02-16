import axios from "axios";
import React, { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { readActualBudgetId } from "./actualBudgetStorage";

type SavedCategory = {
  id: string;
  name: string;
  group_id?: string;
  groupId?: string;
};

type SettingsResponse = {
  settings?: {
    selected_receipt_categories?: SavedCategory[];
  };
};

type ActualCategory = {
  id: string;
  group_id: string;
};

type ActualCategoryGroup = {
  id: string;
  name: string;
  categories: ActualCategory[];
};

type GroupedSavedCategories = {
  groupId: string;
  groupName: string;
  categories: SavedCategory[];
};

type AnalyzeResponse = {
  result?: string;
  error?: string;
};

type PromptsResponse = Record<string, string>;

type Account = {
  id: string;
  name: string;
  offBudget?: boolean;
  closed?: boolean;
};

type RecentTransaction = {
  id: string;
  account?: string;
  category?: string | null;
  amount: number;
  payee?: string;
  notes?: string;
  date: string;
  sort_order?: number;
};

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const CATEGORY_PROMPT_FILENAME = "receipt_categories_prompt.tmpl";

const escapeTemplateSyntax = (value: string): string =>
  value.replace(/{{/g, "{ {").replace(/}}/g, "} }");

const formatCurrencyFromCents = (cents: number): string => {
  if (!Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
};

const groupSavedCategories = (
  selectedCategories: SavedCategory[],
  actualGroups: ActualCategoryGroup[]
): GroupedSavedCategories[] => {
  const groupNameById = new Map<string, string>();
  const categoryGroupMetaByCategoryId = new Map<string, { id: string; name: string }>();

  actualGroups.forEach((group) => {
    groupNameById.set(group.id, group.name);
    group.categories.forEach((category) => {
      categoryGroupMetaByCategoryId.set(category.id, { id: group.id, name: group.name });
    });
  });

  const grouped = new Map<string, GroupedSavedCategories>();
  const seenCategoryIds = new Set<string>();

  selectedCategories.forEach((category) => {
    if (seenCategoryIds.has(category.id)) return;
    seenCategoryIds.add(category.id);

    const explicitGroupId = (category.group_id ?? category.groupId ?? "").trim();
    const inferredGroup = categoryGroupMetaByCategoryId.get(category.id);
    const groupId = explicitGroupId || inferredGroup?.id || "ungrouped";
    const groupName =
      (explicitGroupId ? groupNameById.get(explicitGroupId) : undefined) ||
      inferredGroup?.name ||
      (explicitGroupId ? `Group ${explicitGroupId}` : "Ungrouped");
    const key = `${groupId}:${groupName}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        groupId,
        groupName,
        categories: [],
      });
    }

    grouped.get(key)?.categories.push(category);
  });

  const groupedList = Array.from(grouped.values());
  groupedList.forEach((group) => {
    group.categories.sort((a, b) => a.name.localeCompare(b.name));
  });

  return groupedList.sort((a, b) => a.groupName.localeCompare(b.groupName));
};

const formatTransactionForPrompt = (transaction: RecentTransaction): string => {
  const payee = transaction.payee?.trim() || "No payee";
  const notes = transaction.notes?.trim() || "None";
  const category = transaction.category?.trim() || "Uncategorized";
  const account = transaction.account?.trim() || "Unknown";

  return [
    `- Transaction ID: ${escapeTemplateSyntax(transaction.id)}`,
    `- Date: ${escapeTemplateSyntax(transaction.date || "Unknown")}`,
    `- Payee: ${escapeTemplateSyntax(payee)}`,
    `- Amount (cents): ${transaction.amount}`,
    `- Amount (formatted): ${formatCurrencyFromCents(transaction.amount)}`,
    `- Current category: ${escapeTemplateSyntax(category)}`,
    `- Account: ${escapeTemplateSyntax(account)}`,
    `- Notes: ${escapeTemplateSyntax(notes)}`,
  ].join("\n");
};

const buildCategorizationPrompt = (
  templatePrompt: string,
  groupedCategories: GroupedSavedCategories[],
  transaction: RecentTransaction,
  transactionIndex: number,
  transactionCount: number
): string => {
  const categorySection = groupedCategories.length
    ? groupedCategories
        .map((group) => {
          const categories = group.categories
            .map((category) => `- ${escapeTemplateSyntax(category.name)}`)
            .join("\n");
          return `Group: ${escapeTemplateSyntax(group.groupName)}\n${categories}`;
        })
        .join("\n\n")
    : "No saved categories are configured.";

  const sections = [
    templatePrompt.trim(),
    "Only suggest categories from this list.",
    categorySection,
    "Transaction to categorize:",
    `Transaction ${transactionIndex + 1} of ${transactionCount}`,
    formatTransactionForPrompt(transaction),
    "Reply concisely and include a category name exactly as listed above.",
  ];

  return sections.join("\n\n");
};

const Categorize: React.FC = () => {
  const budgetId = readActualBudgetId();
  const [groupedCategories, setGroupedCategories] = useState<GroupedSavedCategories[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [categoryPrompt, setCategoryPrompt] = useState("");
  const [categoryPromptLoading, setCategoryPromptLoading] = useState(false);
  const [categoryPromptError, setCategoryPromptError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [transactions, setTransactions] = useState<RecentTransaction[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState<string | null>(null);

  const formatLocalYmd = (d: Date): string => {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };
  const today = formatLocalYmd(new Date());
  const twoDaysAgo = formatLocalYmd(new Date(Date.now() - 24 * 60 * 60 * 1000));

  const [fromDate, setFromDate] = useState(twoDaysAgo);
  const [toDate, setToDate] = useState(today);

  const loadSavedCategories = useCallback(async () => {
    setCategoriesLoading(true);
    setCategoriesError(null);

    try {
      const settingsResp = await axios.get<SettingsResponse>("./api/settings");
      const selectedCategories = settingsResp.data?.settings?.selected_receipt_categories ?? [];

      let actualGroups: ActualCategoryGroup[] = [];
      if (budgetId) {
        try {
          const groupsResp = await axios.get<ActualCategoryGroup[]>(
            `./api/actual/budgets/${encodeURIComponent(budgetId)}/categories`
          );
          actualGroups = groupsResp.data;
        } catch (err) {
          console.error("Failed to load Actual category groups:", err);
          setCategoriesError("Saved categories loaded, but category-group metadata failed to load.");
        }
      }

      setGroupedCategories(groupSavedCategories(selectedCategories, actualGroups));
    } catch (err) {
      console.error("Failed to load saved categories:", err);
      setCategoriesError("Failed to load saved categories.");
      setGroupedCategories([]);
    } finally {
      setCategoriesLoading(false);
    }
  }, [budgetId]);

  useEffect(() => {
    loadSavedCategories();
  }, [loadSavedCategories]);

  const loadCategoryPrompt = useCallback(async () => {
    setCategoryPromptLoading(true);
    setCategoryPromptError(null);

    try {
      const response = await axios.get<PromptsResponse>("./api/prompts");
      const promptTemplate = response.data?.[CATEGORY_PROMPT_FILENAME]?.trim() ?? "";

      if (!promptTemplate) {
        setCategoryPrompt("");
        setCategoryPromptError(
          `Prompt "${CATEGORY_PROMPT_FILENAME}" is empty. Update it in Settings > Prompts.`
        );
        return;
      }

      setCategoryPrompt(promptTemplate);
    } catch (err) {
      console.error("Failed to load category prompt from settings:", err);
      setCategoryPrompt("");
      setCategoryPromptError("Failed to load category prompt from settings.");
    } finally {
      setCategoryPromptLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCategoryPrompt();
  }, [loadCategoryPrompt]);

  const loadAccounts = useCallback(async () => {
    if (!budgetId) {
      setAccounts([]);
      setSelectedAccountId("");
      setAccountsError("Budget ID not set. Configure Actual Budget in Connections first.");
      return;
    }

    setAccountsLoading(true);
    setAccountsError(null);

    try {
      const response = await axios.get<Account[]>(
        `./api/actual/budgets/${encodeURIComponent(budgetId)}/accounts`
      );

      const accountList = response.data;
      setAccounts(accountList);

      setSelectedAccountId((prev) => {
        if (prev && accountList.some((account) => account.id === prev)) return prev;
        return accountList[0]?.id ?? "";
      });
    } catch (err) {
      console.error("Failed to load accounts:", err);
      setAccounts([]);
      setSelectedAccountId("");
      setAccountsError("Failed to load Actual accounts.");
    } finally {
      setAccountsLoading(false);
    }
  }, [budgetId]);

  const loadRecentTransactions = useCallback(async () => {
    if (!budgetId || !selectedAccountId) {
      setTransactions([]);
      return;
    }
    if (fromDate && toDate && fromDate > toDate) {
      setTransactionsError("From date must be on or before To date.");
      setTransactions([]);
      return;
    }


    setTransactionsLoading(true);
    setTransactionsError(null);

    try {
      const response = await axios.get<RecentTransaction[]>(
        `./api/actual/budgets/${encodeURIComponent(budgetId)}/accounts/${encodeURIComponent(selectedAccountId)}/transactions`,
        { params: { 
          since_date: fromDate,
          until_date: toDate,
          },
        }
      );
      setTransactions(response.data);
    } catch (err) {
      console.error("Failed to load recent transactions:", err);
      setTransactions([]);
      setTransactionsError("Failed to load recent transactions.");
    } finally {
      setTransactionsLoading(false);
    }
  }, [budgetId, selectedAccountId, fromDate, toDate]);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    loadRecentTransactions();
  }, [loadRecentTransactions]);

  const totalCategoryCount = useMemo(
    () => groupedCategories.reduce((sum, group) => sum + group.categories.length, 0),
    [groupedCategories]
  );

  const sendChat = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (sending) return;
      if (!categoryPrompt.trim()) {
        setChatError(
          `Category prompt is missing. Configure "${CATEGORY_PROMPT_FILENAME}" in Settings > Prompts.`
        );
        return;
      }
      if (transactions.length === 0) {
        setChatError("No transactions loaded. Load transactions before sending to the model.");
        return;
      }

      setChatError(null);
      setSending(true);
      setChatMessages((prev) => [
        ...prev,
        { role: "user", content: `Categorize ${transactions.length} transaction(s).` },
      ]);

      try {
        const responses: string[] = [];
        let failedCount = 0;

        for (const [index, transaction] of transactions.entries()) {
          const transactionLabel = [
            transaction.date || "Unknown date",
            transaction.payee?.trim() || "No payee",
            formatCurrencyFromCents(transaction.amount),
          ].join(" | ");

          const prompt = buildCategorizationPrompt(
            categoryPrompt,
            groupedCategories,
            transaction,
            index,
            transactions.length
          );

          try {
            const response = await axios.post<AnalyzeResponse>("./api/analyze-documents", {
              document_ids: [],
              prompt,
            });
            const modelMessage = response.data?.result?.trim() || "Model returned an empty response.";
            responses.push(
              `Transaction ${index + 1}/${transactions.length}: ${transactionLabel}\n${modelMessage}`
            );
          } catch (err) {
            failedCount += 1;
            console.error(`Failed to categorize transaction ${transaction.id}:`, err);
            responses.push(
              `Transaction ${index + 1}/${transactions.length}: ${transactionLabel}\nFailed to categorize this transaction.`
            );
          }
        }

        if (failedCount > 0) {
          setChatError(
            `Failed to categorize ${failedCount} of ${transactions.length} transaction(s). See results for details.`
          );
        }

        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: responses.join("\n\n"),
          },
        ]);
      } catch (err) {
        console.error("Failed to send categorization chat prompt:", err);
        setChatError("Failed to send message to the model.");
        setChatMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "I could not get a response from the model. Please try again.",
          },
        ]);
      } finally {
        setSending(false);
      }
    },
    [categoryPrompt, groupedCategories, sending, transactions]
  );

  const panelClass =
    "flex min-h-0 flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800";
  const controlClass =
    "w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/40 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";
  const primaryButtonClass =
    "rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300";

  return (
    <main className="h-full bg-gray-100 p-4 text-gray-900 dark:bg-gray-900 dark:text-gray-100 md:p-6">
      <div className="mx-auto flex h-full max-w-[1700px] flex-col gap-4">
        <header className="rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <h1 className="text-2xl font-bold tracking-tight">Actual Budget Categorizer</h1>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Review saved categories, inspect recent account activity, and ask the model for categorization help.
          </p>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
          <section className={panelClass}>
            <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/80">
              <div>
                <h2 className="text-base font-semibold">Saved Categories</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {totalCategoryCount} selected categories
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  Budget ID: {budgetId || "Not set"}
                </p>
              </div>
              <button
                type="button"
                onClick={loadSavedCategories}
                disabled={categoriesLoading}
                className={primaryButtonClass}
              >
                {categoriesLoading ? "Loading..." : "Refresh"}
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
              {categoriesError && (
                <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                  {categoriesError}
                </p>
              )}

              {!categoriesLoading && groupedCategories.length === 0 && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  No saved categories yet. Pick and save categories in Connections first.
                </p>
              )}

              <div className="space-y-4">
                {groupedCategories.map((group) => (
                  <div
                    key={`${group.groupId}:${group.groupName}`}
                    className="space-y-2 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/60"
                  >
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {group.groupName}
                    </h3>
                    <ul className="flex flex-wrap gap-2">
                      {group.categories.map((category) => (
                        <li
                          key={category.id}
                          className="rounded-md border border-gray-200 bg-white px-2.5 py-1 text-sm text-gray-800 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                        >
                          {category.name}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className={`${panelClass} xl:col-span-2 2xl:col-span-1`}>
            <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/80">
              <h2 className="text-base font-semibold">Categorization Chat</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Uses the saved category prompt from Settings plus selected categories and loaded transactions.
              </p>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-gray-50/40 p-4 dark:bg-gray-900/50">
              {chatMessages.length === 0 && (
                <p className="rounded-md border border-dashed border-gray-300 bg-white px-3 py-2 text-sm text-gray-600 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-300">
                  Send loaded transactions to the model for category suggestions.
                </p>
              )}

              {chatMessages.map((message, index) => (
                <div
                  key={`${message.role}-${index}`}
                  className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                    message.role === "user"
                      ? "ml-auto bg-blue-600 text-white"
                      : "mr-auto bg-gray-100 text-gray-900 dark:bg-gray-700 dark:text-gray-100"
                  }`}
                >
                  <p className="whitespace-pre-wrap">{message.content}</p>
                </div>
              ))}
            </div>

            <form
              onSubmit={sendChat}
              className="space-y-3 border-t border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800"
            >
              {chatError && <p className="mb-2 text-sm text-red-600 dark:text-red-300">{chatError}</p>}
              {categoryPromptError && (
                <p className="mb-2 text-sm text-red-600 dark:text-red-300">{categoryPromptError}</p>
              )}
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Prompt source: <code>{CATEGORY_PROMPT_FILENAME}</code>{" "}
                {categoryPromptLoading ? "(loading...)" : categoryPrompt ? "(loaded)" : "(not loaded)"}
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={loadCategoryPrompt}
                  disabled={categoryPromptLoading || sending}
                  className="rounded-md border border-gray-300 px-3 py-2 text-sm font-semibold text-gray-700 transition hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-60 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
                >
                  {categoryPromptLoading ? "Loading prompt..." : "Reload prompt"}
                </button>
                <button
                  type="submit"
                  disabled={sending || categoryPromptLoading || !categoryPrompt.trim() || transactions.length === 0}
                  className={primaryButtonClass}
                >
                  {sending ? "Sending..." : "Send to model"}
                </button>
              </div>
            </form>
          </section>

          <section className={panelClass}>
            <div className="border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/80">
              <h2 className="text-base font-semibold">Recent Transactions</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Selected range: {fromDate || "—"} to {toDate || "—"}
              </p>
            </div>

            <div className="space-y-3 border-b border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/40">
              <label htmlFor="actual-account-select" className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                Account
              </label>
              <div className="flex items-center gap-2">
                <select
                  id="actual-account-select"
                  value={selectedAccountId}
                  onChange={(event) => setSelectedAccountId(event.target.value)}
                  disabled={accountsLoading || accounts.length === 0}
                  className={controlClass}
                >
                  {!accounts.length && (
                    <option value="">{accountsLoading ? "Loading accounts..." : "No accounts"}</option>
                  )}
                  {accounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={loadRecentTransactions}
                  disabled={transactionsLoading || !selectedAccountId}
                  className={`${primaryButtonClass} whitespace-nowrap`}
                >
                  {transactionsLoading ? "Loading..." : "Refresh"}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <div>
                  <label htmlFor="from-date" className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                    From
                  </label>
                  <input
                    id="from-date"
                    type="date"
                    value={fromDate}
                    onChange={(e) => setFromDate(e.target.value)}
                    className={controlClass}
                  />
                </div>
                <div>
                  <label htmlFor="to-date" className="text-xs font-semibold text-gray-700 dark:text-gray-200">
                    To
                  </label>
                  <input
                    id="to-date"
                    type="date"
                    value={toDate}
                    onChange={(e) => setToDate(e.target.value)}
                    className={controlClass}
                  />
                </div>
              </div>

              {accountsError && (
                <p className="text-sm text-red-600 dark:text-red-300">
                  {accountsError}
                </p>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {transactionsError && (
                <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-200">
                  {transactionsError}
                </p>
              )}

              {!transactionsLoading && !transactionsError && transactions.length === 0 && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  No transactions found for the selected account in the selected date range.
                </p>
              )}

              <div className="space-y-2">
                {transactions.map((transaction) => (
                  <article
                    key={transaction.id}
                    className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm shadow-sm dark:border-gray-700 dark:bg-gray-900"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900 dark:text-gray-100">
                        {transaction.payee?.trim() || "No payee"}
                      </p>
                      <p className="font-semibold text-gray-900 dark:text-gray-100">
                        {formatCurrencyFromCents(transaction.amount)}
                      </p>
                    </div>
                    <div className="mt-1 text-xs text-gray-600 dark:text-gray-300">
                      <p>Date: {transaction.date || "—"}</p>
                      <p>Category: {transaction.category || "Uncategorized"}</p>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
};

export default Categorize;
