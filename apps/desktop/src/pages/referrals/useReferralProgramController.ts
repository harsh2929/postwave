import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { toast } from "../../components/Toast";
import {
  type ReferralMilestone,
  type ReferralProgram,
  api,
} from "../../lib/api-client";
import {
  normalizeReferralProgram,
  programReplaceFields,
} from "./referral-program";

export interface ReferralProgramState {
  empty: boolean;
  error: string | null;
  loading: boolean;
  program: ReferralProgram | null;
}

export interface ReferralProgramController {
  deleting: boolean;
  load: () => Promise<void>;
  milestones: ReferralMilestone[];
  removeMilestone: (count: number) => Promise<boolean>;
  state: ReferralProgramState;
}

const INITIAL_STATE: ReferralProgramState = {
  empty: false,
  error: null,
  loading: true,
  program: null,
};

export function useReferralProgramController(
  canMutate: boolean,
): ReferralProgramController {
  const [state, setState] = useState<ReferralProgramState>(INITIAL_STATE);
  const [deleting, setDeleting] = useState(false);
  const activeRef = useRef(true);
  const loadSequence = useRef(0);
  const mutationSequence = useRef(0);
  const deletingRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
      loadSequence.current += 1;
      mutationSequence.current += 1;
      deletingRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++loadSequence.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const result = await api.getReferralProgram();
      if (!activeRef.current || requestId !== loadSequence.current) return;
      if (result.error) {
        if (result.error.status === 404) {
          setState({ empty: true, error: null, loading: false, program: null });
          return;
        }
        setState((current) => ({
          empty: false,
          error: result.error.message,
          loading: false,
          program: current.program,
        }));
        return;
      }
      const program = normalizeReferralProgram(result.data);
      if (!program) {
        setState((current) => ({
          empty: false,
          error: "The referral program response was invalid.",
          loading: false,
          program: current.program,
        }));
        return;
      }
      setState({ empty: false, error: null, loading: false, program });
    } catch (error) {
      if (!activeRef.current || requestId !== loadSequence.current) return;
      setState((current) => ({
        empty: false,
        error:
          error instanceof Error ? error.message : "Couldn't load program.",
        loading: false,
        program: current.program,
      }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (canMutate) return;
    mutationSequence.current += 1;
    deletingRef.current = false;
    setDeleting(false);
  }, [canMutate]);

  const milestones = useMemo(
    () =>
      [...(state.program?.milestones ?? [])].sort(
        (left, right) => left.count - right.count,
      ),
    [state.program],
  );

  const removeMilestone = useCallback(
    async (count: number): Promise<boolean> => {
      if (!canMutate) {
        toast.error("Only workspace admins can delete referral milestones");
        return false;
      }
      if (deletingRef.current || !state.program) return false;
      const next = milestones.filter((milestone) => milestone.count !== count);
      if (next.length === milestones.length) return false;
      if (next.length === 0) {
        toast.error(
          "A program needs at least one milestone — use Edit to redefine.",
        );
        return false;
      }

      const requestId = ++mutationSequence.current;
      deletingRef.current = true;
      setDeleting(true);
      try {
        const result = await api.setReferralProgram({
          milestones: next,
          expires_at: state.program.expiresAt ?? null,
          expected_program_id: state.program.id,
          ...programReplaceFields(state.program),
        });
        if (
          !activeRef.current ||
          requestId !== mutationSequence.current ||
          !canMutate
        ) {
          return false;
        }
        if (result.error) {
          toast.error(`Couldn't save: ${result.error.message}`);
          return false;
        }
        toast.success("Milestone removed");
        await load();
        return activeRef.current && requestId === mutationSequence.current;
      } catch (error) {
        if (activeRef.current && requestId === mutationSequence.current) {
          toast.error(
            `Couldn't save: ${
              error instanceof Error ? error.message : "Unexpected error"
            }`,
          );
        }
        return false;
      } finally {
        if (activeRef.current && requestId === mutationSequence.current) {
          deletingRef.current = false;
          setDeleting(false);
        }
      }
    },
    [canMutate, load, milestones, state.program],
  );

  return { deleting, load, milestones, removeMilestone, state };
}
