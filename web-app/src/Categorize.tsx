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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

const escapeTemplateSyntax = (value: string): string =>
  value.replace("{{", "{ {").replace("}}", "} }");

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

const buildCategorizationPrompt = (
  groupedCategories: GroupedSavedCategories[],
  userMessage: string
): string => {
  const categorySection = groupedCategories.length
    ? groupedCategories
        .map((group) => {
          const categories = group.categories
            .map((category) => `- ${escapeTemplateSyntax(category.name)} (${category.id})`)
            .join("\n");
          return `Group: ${escapeTemplateSyntax(group.groupName)}\n${categories}`;
        })
        .join("\n\n")
    : "No saved categories are configured.";

  return [
    "You are an assistant for categorizing Actual Budget transactions.",
    "Only suggest categories from this list.",
    categorySection,
    "User request:",
    escapeTemplateSyntax(userMessage),
    "Reply concisely and include category names exactly as listed when you suggest a category.",
  ].join("\n\n");
};

const Categorize: React.FC = () => {
  const budgetId = readActualBudgetId();
  const [groupedCategories, setGroupedCategories] = useState<GroupedSavedCategories[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);

  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);

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

  const totalCategoryCount = useMemo(
    () => groupedCategories.reduce((sum, group) => sum + group.categories.length, 0),
    [groupedCategories]
  );

  const sendChat = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (sending) return;

      const message = chatInput.trim();
      if (!message) return;

      setChatError(null);
      setSending(true);
      setChatInput("");
      setChatMessages((prev) => [...prev, { role: "user", content: message }]);

      try {
        const prompt = buildCategorizationPrompt(groupedCategories, message);
        const response = await axios.post<AnalyzeResponse>("./api/analyze-documents", {
          document_ids: [],
          prompt,
        });
        const modelMessage = response.data?.result?.trim() || "Model returned an empty response.";
        setChatMessages((prev) => [...prev, { role: "assistant", content: modelMessage }]);
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
    [chatInput, groupedCategories, sending]
  );

  return (
    <main className="h-full bg-gray-50 p-6 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
      <div className="mx-auto flex h-full max-w-7xl flex-col gap-4">
        <header>
          <h1 className="text-2xl font-bold">Actual Budget Categorizer</h1>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            Saved categories from Connections on the left, model chat on the right.
          </p>
        </header>

        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-2">
          <section className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700">
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
                className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
              >
                {categoriesLoading ? "Loading..." : "Refresh"}
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
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
                  <div key={`${group.groupId}:${group.groupName}`} className="space-y-2">
                    <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">
                      {group.groupName}
                    </h3>
                    <ul className="flex flex-wrap gap-2">
                      {group.categories.map((category) => (
                        <li
                          key={category.id}
                          className="rounded-md bg-gray-100 px-2.5 py-1 text-sm text-gray-800 dark:bg-gray-700 dark:text-gray-100"
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

          <section className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <div className="border-b border-gray-200 px-4 py-3 dark:border-gray-700">
              <h2 className="text-base font-semibold">Categorization Chat</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Sends your prompt plus selected categories to the model.
              </p>
            </div>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
              {chatMessages.length === 0 && (
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  Start by asking the model how to categorize transactions.
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

            <form onSubmit={sendChat} className="border-t border-gray-200 p-4 dark:border-gray-700">
              {chatError && <p className="mb-2 text-sm text-red-600 dark:text-red-300">{chatError}</p>}
              <label htmlFor="categorize-chat-input" className="sr-only">
                Ask the categorization model
              </label>
              <textarea
                id="categorize-chat-input"
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                rows={4}
                placeholder="Example: Categorize these transactions and explain your reasoning."
                className="w-full rounded-md border border-gray-300 p-3 text-sm text-gray-900 outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
              <div className="mt-3 flex justify-end">
                <button
                  type="submit"
                  disabled={sending || !chatInput.trim()}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-300"
                >
                  {sending ? "Sending..." : "Send to model"}
                </button>
              </div>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
};

export default Categorize;
