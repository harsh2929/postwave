import { useEffect, useRef, useState } from "react";

import { toast } from "../../components/Toast";
import {
  integrationsApi,
  type IntegrationDetailResponse,
  type IntegrationRecipe,
  type IntegrationRecipeApplyResponse,
  type IntegrationRecipeDetailResponse,
} from "../../lib/api-client";
import { integrationApiErrorDetail } from "../integrations-helpers";
import {
  parseIntegrationRecipeDetail,
  parseIntegrationRecipePrepareResponse,
} from "../integrations-response-contract";

export interface IntegrationRecipeController {
  selectedRecipeID: string;
  selectedRecipe: IntegrationRecipe | null;
  recipeDetail: IntegrationRecipeDetailResponse | null;
  recipeDetailLoading: boolean;
  recipeApply: IntegrationRecipeApplyResponse | null;
  recipeApplyBusy: string;
  pendingRecipe: IntegrationRecipe | null;
  openRecipeDetail: (
    recipe: IntegrationRecipe,
    resetApply?: boolean,
  ) => Promise<void>;
  applyRecipe: (recipe: IntegrationRecipe) => Promise<void>;
  confirmRecipePreparation: () => Promise<void>;
  closeRecipePreparation: () => void;
  closeRecipe: () => void;
}

interface RecipeControllerOptions {
  canAdmin: boolean;
  recipes: IntegrationRecipe[];
  detail: IntegrationDetailResponse | null;
}

export function useIntegrationRecipeController({
  canAdmin,
  recipes,
  detail,
}: RecipeControllerOptions): IntegrationRecipeController {
  const [selectedRecipeID, setSelectedRecipeID] = useState("");
  const [recipeDetail, setRecipeDetail] =
    useState<IntegrationRecipeDetailResponse | null>(null);
  const [recipeDetailLoading, setRecipeDetailLoading] = useState(false);
  const [recipeApply, setRecipeApply] =
    useState<IntegrationRecipeApplyResponse | null>(null);
  const [recipeApplyBusy, setRecipeApplyBusy] = useState("");
  const [pendingRecipe, setPendingRecipe] = useState<IntegrationRecipe | null>(
    null,
  );
  const mountedRef = useRef(true);
  const detailRequestSequence = useRef(0);
  const preparationBusyRef = useRef("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      detailRequestSequence.current += 1;
      preparationBusyRef.current = "";
    };
  }, []);

  const openRecipeDetail = async (
    recipe: IntegrationRecipe,
    resetApply = true,
  ): Promise<void> => {
    const sequence = detailRequestSequence.current + 1;
    detailRequestSequence.current = sequence;
    setSelectedRecipeID(recipe.id);
    setRecipeDetail(null);
    if (resetApply) setRecipeApply(null);
    setRecipeDetailLoading(true);
    try {
      const result = await integrationsApi.recipeDetail(recipe.id);
      if (!mountedRef.current || detailRequestSequence.current !== sequence) {
        return;
      }
      if (result.error) {
        toast.error({
          message: `Could not load ${recipe.name}`,
          detail: integrationApiErrorDetail(result.error),
        });
        return;
      }
      const parsed = parseIntegrationRecipeDetail(result.data, recipe.id);
      if (!parsed) {
        toast.error({
          message: `Could not verify ${recipe.name}`,
          detail:
            "The server returned malformed or mismatched recipe evidence.",
        });
        return;
      }
      setRecipeDetail(parsed);
    } finally {
      if (mountedRef.current && detailRequestSequence.current === sequence) {
        setRecipeDetailLoading(false);
      }
    }
  };

  const requestRecipePreparation = async (
    recipe: IntegrationRecipe,
  ): Promise<void> => {
    if (!canAdmin) {
      toast.error("Admin access is required to prepare integration recipes.");
      return;
    }
    if (!recipe.available) {
      toast.info({
        message: `${recipe.name} is still planned`,
        detail:
          "Its blueprint is available for review, but setup cannot be prepared yet.",
      });
      await openRecipeDetail(recipe);
      return;
    }
    if (preparationBusyRef.current) {
      toast.info("Wait for the current recipe preparation to finish.");
      return;
    }
    setSelectedRecipeID(recipe.id);
    setPendingRecipe(recipe);
    if (recipeDetail?.recipe.id !== recipe.id) {
      void openRecipeDetail(recipe, false);
    }
  };

  const confirmRecipePreparation = async (): Promise<void> => {
    const recipe = pendingRecipe;
    if (!recipe || preparationBusyRef.current) return;
    if (!canAdmin || !recipe.available) {
      setPendingRecipe(null);
      toast.error("This recipe is not available to prepare.");
      return;
    }
    preparationBusyRef.current = recipe.id;
    setRecipeApplyBusy(recipe.id);
    try {
      const result = await integrationsApi.applyRecipe(recipe.id);
      if (!mountedRef.current) return;
      if (result.error) {
        toast.error({
          message: `${recipe.name} setup could not be prepared`,
          detail: integrationApiErrorDetail(result.error),
        });
        return;
      }
      const parsed = parseIntegrationRecipePrepareResponse(
        result.data,
        recipe.id,
      );
      if (!parsed) {
        toast.error({
          message: `${recipe.name} could not be verified`,
          detail: "The server returned malformed or mismatched setup evidence.",
        });
        return;
      }
      if (parsed.status !== "delegated") {
        toast.info({
          message: `${recipe.name} is not available to prepare`,
          detail:
            "The server now classifies this recipe as planned. No setup plan or automation was created.",
        });
        return;
      }
      setRecipeApply(parsed);
      setPendingRecipe(null);
      toast.info({
        message: `${recipe.name} setup plan is ready`,
        detail:
          parsed.status === "delegated"
            ? "No automation was created. Continue through the owning setup surface using the reviewed fields below."
            : (parsed.message ?? parsed.manage_path),
      });
    } finally {
      if (preparationBusyRef.current === recipe.id) {
        preparationBusyRef.current = "";
        if (mountedRef.current) setRecipeApplyBusy("");
      }
    }
  };

  const selectedRecipe = selectedRecipeID
    ? (recipes.find((recipe) => recipe.id === selectedRecipeID) ??
      detail?.recipes.find((recipe) => recipe.id === selectedRecipeID) ??
      null)
    : null;

  return {
    selectedRecipeID,
    selectedRecipe,
    recipeDetail,
    recipeDetailLoading,
    recipeApply,
    recipeApplyBusy,
    pendingRecipe,
    openRecipeDetail,
    applyRecipe: requestRecipePreparation,
    confirmRecipePreparation,
    closeRecipePreparation: () => {
      if (!preparationBusyRef.current) setPendingRecipe(null);
    },
    closeRecipe: () => {
      detailRequestSequence.current += 1;
      setSelectedRecipeID("");
      setRecipeDetail(null);
      setRecipeApply(null);
      setPendingRecipe(null);
      setRecipeDetailLoading(false);
    },
  };
}
