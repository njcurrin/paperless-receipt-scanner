import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { readActualBudgetId, writeActualBudgetId } from './actualBudgetStorage';

type Budget = { groupId: string, name: string, hasKey?: boolean };
type Category = { id: string, name: string, group_id: string, is_income: boolean };
type CategoryGroup = { id: string, name: string, is_income: boolean, categories: Category[] };

const Connections: React.FC = () => {
  //const [titleActualBudgetUrl, setTitleActualBudgetUrl] = useState('');
  const [budgetId, setBudgetId] = useState(readActualBudgetId);
  //const [budgetPass, setBudgetPass] = useState('');
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [budgetsLoading, setBudgetsLoading] = useState(false);
  const [budgetsError, setBudgetsError] = useState<string | null>(null);
  const [selectedBudgetId, setSelectedBudgetId] = useState(readActualBudgetId);
  const [categoryGroups, setCategoryGroups] = useState<CategoryGroup[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategoryIds, setSelectedCategoryIds] = useState<Set<string>>(new Set());
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [categoriesError, setCategoriesError] = useState<string | null>(null);
  const [savingCategories, setSavingCategories] = useState(false);


  const SaveActualClient = useCallback(async () => {
    if (!budgetId) {
      setCategoriesError("Please select a budget first.");
      return;
    }

    setCategoriesLoading(true);
    setCategoriesError(null);
    setCategoryGroups([]);
    setCategories([]);
    //setSelectedCategoryIds(new Set());

    try {
      const resp = await axios.get<CategoryGroup[]>(
        `./api/actual/budgets/${encodeURIComponent(budgetId)}/categories`
      );
      const sorted = [...resp.data].sort((a, b) => a.name.localeCompare(b.name));
      setCategoryGroups(sorted);
    } catch (err) {
      console.error("Failed to load categories:", err);
      setCategoriesError("Failed to load categories.");
    } finally {
      setCategoriesLoading(false);
    }
    // const flatCat = categoryGroups.flatMap(group => group.categories)
    // setCategories(flatCat);
    // console.log(categoryGroups)
  }, [budgetId]);

  const SaveBudgetCategories = useCallback(async () => {
   if (!budgetId) {
    setCategoriesError("Please select a Budget first.");
    return;
   }
   if (selectedCategoryIds.size === 0) {
    setCategoriesError("Please select at least one Category.");
    return;
   }

   setCategoriesError(null);

  const flatCat = categoryGroups.flatMap(group => group.categories)
   //setCategories(flatCat);
  //  console.log(flatCat)

   //

   const selectedCategories = flatCat
    .filter((c) => selectedCategoryIds.has(c.id))
    .map((c) => ({
      id: c.id,
      name: c.name,
      groupId: c.group_id,
    }));
   setSavingCategories(true);
  try {
    await axios.post(
      `./api/actual/budgets/${encodeURIComponent(budgetId)}/categories`,
      { categories: selectedCategories }
    );
  } catch (err) {
    console.error("Failed to save selected categories:", err);
    setCategoriesError("Failed to save selected categories.")
  } finally {
    setSavingCategories(false);
  }
  },[budgetId, selectedCategoryIds, categories]);

  const toggleCategorySelected = useCallback((categoryId: string) => {
    setSelectedCategoryIds((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  }, []);
  useEffect(() => {
    writeActualBudgetId(budgetId);
  }, [budgetId]);

  useEffect(() => {
    let cancelled = false;

    const loadBudgets = async () => {
      setBudgetsLoading(true);
      setBudgetsError(null);
      try {
        const resp = await axios.get<Budget[]>("./api/actual/budgets")
        if (!cancelled) setBudgets(resp.data);
      } catch (err){
        console.error("Failed to load budgets:", err);
        if (!cancelled) setBudgetsError("Failed to Load budgets");
        console.error(budgetsError)        
      } finally {
        if (!cancelled) setBudgetsLoading(false);
      }
    }
    loadBudgets();
    return () => {cancelled = true; };
  }, []);
  return (
    <div className="max-w-3xl mx-auto p-6 bg-white dark:bg-gray-900 text-gray-800 dark:text-black-200">
      <h1 className="text-4xl font-bold mb-6 text-center">OCR via LLMs (Experimental)</h1>
      <p className="mb-6 text-center text-yellow-600">
        This is an experimental feature. Results may vary, and processing may take some time.
      </p>
      <div className="bg-gray-100 dark:bg-gray-800 p-6 rounded-lg shadow-md">
        <div className="mb-4">
          <label htmlFor="actualBudget" className="block mb-2 font-semibold">
            Actual Budget:
          </label>
          <select
            id="actualBudget"
            value={selectedBudgetId}
            onChange={(e) => {
              const id = e.target.value; 
              setSelectedBudgetId(id); 
              setBudgetId(id);
              setCategories([]);
              setSelectedCategoryIds(new Set());
              setCategoriesError(null);
            }}
            className="border border-gray-300 dark:border-gray-700 rounded w-full p-2 focus:outline-none focus:ring-2 focus:ring-blue-500 color:rgba(71, 212, 156, 1)"
          >
              <option value="">
                {budgetsLoading ? "Loading budgets..." : "Select a budget"}
              </option>
                {budgets.map((b) => (
                  <option key={b.groupId} value={b.groupId}>
                    {b.name}
                  </option>
                ))}
            </select>
        </div>
        <div className="mb-4">
          <label htmlFor="budgetId" className="block mb-2 font-semibold">
            Budget ID:
          </label>
          <input
            type="text"
            id="budgetId"
            value={budgetId}
            onChange={(e) => setBudgetId(e.target.value)}
            className="border border-gray-300 dark:border-gray-700 rounded w-full p-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="Enter Budget ID"
          />
        </div>
        <button
          type="button"
          onClick={SaveActualClient}
          disabled={!budgetId || categoriesLoading}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition duration-200"
        >
          {categoriesLoading ? "Loading categories..." : "Save"}
        </button>

        {categoriesError && (
          <p className="mt-4 text-sm text-red-600">
            {categoriesError}
          </p>
        )}

{categoryGroups.map((group) => (
  <div key={group.id}>
    <div className="font-semibold text-sm mb-2">{group.name}</div>
    <div className="text-xs text-gray-500 dark:text-gray-400">
      <h2>
          Group: {group.name}
        </h2>
        </div>
    {group.categories.map((cat) => (
      <div
        key={cat.id}
        role="button"
        tabIndex={0}
        onClick={() => toggleCategorySelected(cat.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleCategorySelected(cat.id);
          }
        }}
        className={`bg-white dark:bg-gray-900 border rounded-md px-3 py-2 cursor-pointer transition ${
          selectedCategoryIds.has(cat.id)
            ? 'border-blue-500 ring-1 ring-blue-500'
            : 'border-gray-200 dark:border-gray-700'
        }`}
      >
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selectedCategoryIds.has(cat.id)}
            onChange={() => toggleCategorySelected(cat.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select category ${cat.name}`}
          />
          <div className="font-medium">{cat.name}</div>
        </div>
      </div>
    ))}
  </div>
))}

            </div>
            <button
          type="button"
          onClick={SaveBudgetCategories}
          disabled={!budgetId || categoriesLoading || savingCategories || selectedCategoryIds.size === 0}
          className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white font-semibold py-2 px-4 rounded transition duration-200"
        >
          {savingCategories ? "Saving categories..." : "Save"}
        </button>
          </div>
        )}


export default Connections;
