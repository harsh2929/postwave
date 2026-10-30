import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type PredictiveCatalogResponse,
  type PredictivePrediction,
  type PredictiveProfileAnalytics,
  type RFMScoreRow,
  predictiveApi,
} from "../../lib/api-client";
import { toast } from "../Toast";
import {
  buildRFMGrid,
  parseRFMSegmentCatalog,
  recomputeToastCopy,
  rfmSegmentCounts,
} from "./rfm-helpers";

export const PROFILE_LIMITS = [25, 50, 100, 250] as const;
export type ProfileLimit = (typeof PROFILE_LIMITS)[number];

function thrownMessage(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  return "Unexpected predictive service failure.";
}

function isProfileLimit(value: number): value is ProfileLimit {
  return PROFILE_LIMITS.some((limit) => limit === value);
}

export function useRFMSectionController(canAdmin: boolean) {
  const [catalog, setCatalog] = useState<PredictiveCatalogResponse | null>(
    null,
  );
  const [rows, setRows] = useState<RFMScoreRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [profile, setProfile] = useState<PredictiveProfileAnalytics | null>(
    null,
  );
  const [profileError, setProfileError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [profileSegment, setProfileSegment] = useState("");
  const [profileLimit, setProfileLimitState] = useState<ProfileLimit>(50);
  const [profileRows, setProfileRows] = useState<PredictivePrediction[] | null>(
    null,
  );
  const [profilesError, setProfilesError] = useState<string | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(true);

  const activeRef = useRef(false);
  const canAdminRef = useRef(canAdmin);
  const emailRef = useRef(email);
  const overviewRequestRef = useRef(0);
  const overviewBusyRef = useRef(false);
  const profilesRequestRef = useRef(0);
  const profilesKeyRef = useRef<string | null>(null);
  const lookupRequestRef = useRef(0);
  const lookupBusyRef = useRef(false);
  const recomputeRequestRef = useRef(0);
  const recomputeBusyRef = useRef(false);
  canAdminRef.current = canAdmin;
  emailRef.current = email;

  const loadOverview = useCallback(
    async (options: { supersede?: boolean } = {}): Promise<void> => {
      if (
        !activeRef.current ||
        (overviewBusyRef.current && !options.supersede)
      ) {
        return;
      }
      const requestId = ++overviewRequestRef.current;
      overviewBusyRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const [catalogResult, rfmResult] = await Promise.all([
          predictiveApi.catalog(),
          predictiveApi.rfmSegments(),
        ]);
        if (!activeRef.current || requestId !== overviewRequestRef.current) {
          return;
        }
        if (catalogResult.error && rfmResult.error) {
          setError(catalogResult.error.message);
          setCatalog(null);
          setRows(null);
          return;
        }
        setCatalog(catalogResult.error ? null : (catalogResult.data ?? null));
        setRows(
          rfmResult.error
            ? null
            : Array.isArray(rfmResult.data?.items)
              ? rfmResult.data.items
              : [],
        );
        setError(
          catalogResult.error?.message ?? rfmResult.error?.message ?? null,
        );
      } catch (reason) {
        if (!activeRef.current || requestId !== overviewRequestRef.current) {
          return;
        }
        setCatalog(null);
        setRows(null);
        setError(thrownMessage(reason));
      } finally {
        if (activeRef.current && requestId === overviewRequestRef.current) {
          overviewBusyRef.current = false;
          setLoading(false);
        }
      }
    },
    [],
  );

  const loadProfiles = useCallback(
    async (segment: string, limit: ProfileLimit): Promise<void> => {
      if (!activeRef.current) return;
      const requestKey = `${segment}\u0000${limit}`;
      if (profilesKeyRef.current === requestKey) return;
      const requestId = ++profilesRequestRef.current;
      profilesKeyRef.current = requestKey;
      setProfilesLoading(true);
      setProfilesError(null);
      try {
        const result = await predictiveApi.profiles({
          ...(segment ? { segment } : {}),
          limit,
        });
        if (!activeRef.current || requestId !== profilesRequestRef.current) {
          return;
        }
        if (result.error) {
          setProfileRows(null);
          setProfilesError(result.error.message);
          return;
        }
        setProfileRows(
          Array.isArray(result.data?.items)
            ? result.data.items.map((item) => item.prediction)
            : [],
        );
      } catch (reason) {
        if (!activeRef.current || requestId !== profilesRequestRef.current) {
          return;
        }
        setProfileRows(null);
        setProfilesError(thrownMessage(reason));
      } finally {
        if (activeRef.current && requestId === profilesRequestRef.current) {
          profilesKeyRef.current = null;
          setProfilesLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    activeRef.current = true;
    void loadOverview({ supersede: true });
    return () => {
      activeRef.current = false;
      overviewRequestRef.current += 1;
      profilesRequestRef.current += 1;
      lookupRequestRef.current += 1;
      recomputeRequestRef.current += 1;
      overviewBusyRef.current = false;
      profilesKeyRef.current = null;
      lookupBusyRef.current = false;
      recomputeBusyRef.current = false;
    };
  }, [loadOverview]);

  useEffect(() => {
    void loadProfiles(profileSegment, profileLimit);
  }, [loadProfiles, profileLimit, profileSegment]);

  const updateEmail = useCallback((value: string): void => {
    emailRef.current = value;
    lookupRequestRef.current += 1;
    lookupBusyRef.current = false;
    setEmail(value);
    setProfile(null);
    setProfileError(null);
    setLookingUp(false);
  }, []);

  const lookup = useCallback(async (): Promise<void> => {
    const normalizedEmail = emailRef.current.trim().toLowerCase();
    if (!activeRef.current || lookupBusyRef.current) return;
    if (!normalizedEmail) {
      setProfile(null);
      setProfileError("Enter a subscriber email first.");
      return;
    }
    const requestId = ++lookupRequestRef.current;
    lookupBusyRef.current = true;
    setLookingUp(true);
    setProfile(null);
    setProfileError(null);
    try {
      const result = await predictiveApi.profile(normalizedEmail);
      if (!activeRef.current || requestId !== lookupRequestRef.current) return;
      if (result.error) {
        setProfileError(
          result.error.status === 404
            ? "No predictive profile for that email — either it isn't a known subscriber with order history, or scores haven't been computed yet."
            : result.error.message,
        );
        return;
      }
      if (!result.data) {
        setProfileError("The predictive service returned an empty profile.");
        return;
      }
      setProfile(result.data);
    } catch (reason) {
      if (!activeRef.current || requestId !== lookupRequestRef.current) return;
      setProfileError(thrownMessage(reason));
    } finally {
      if (activeRef.current && requestId === lookupRequestRef.current) {
        lookupBusyRef.current = false;
        setLookingUp(false);
      }
    }
  }, []);

  const recompute = useCallback(async (): Promise<void> => {
    if (
      !activeRef.current ||
      !canAdminRef.current ||
      recomputeBusyRef.current
    ) {
      return;
    }
    const requestId = ++recomputeRequestRef.current;
    recomputeBusyRef.current = true;
    setRecomputing(true);
    try {
      const result = await predictiveApi.recompute();
      if (!activeRef.current || requestId !== recomputeRequestRef.current) {
        return;
      }
      if (result.error) {
        toast.error({
          message: "Recompute failed",
          detail: result.error.message,
        });
        return;
      }
      if (result.data) {
        const copy = recomputeToastCopy(result.data);
        if (copy.ok) {
          toast.success({ message: copy.message, detail: copy.detail });
        } else {
          toast.error({ message: copy.message, detail: copy.detail });
        }
      }
      await loadOverview({ supersede: true });
    } catch (reason) {
      if (activeRef.current && requestId === recomputeRequestRef.current) {
        toast.error({
          message: "Recompute failed",
          detail: thrownMessage(reason),
        });
      }
    } finally {
      if (activeRef.current && requestId === recomputeRequestRef.current) {
        recomputeBusyRef.current = false;
        setRecomputing(false);
      }
    }
  }, [loadOverview]);

  const grid = useMemo(() => (rows ? buildRFMGrid(rows) : null), [rows]);
  const segmentCounts = useMemo(
    () =>
      rows
        ? rfmSegmentCounts(rows, parseRFMSegmentCatalog(catalog?.rfm_segments))
        : [],
    [catalog?.rfm_segments, rows],
  );

  return {
    catalog,
    grid,
    segmentCounts,
    loading,
    error,
    email,
    profile,
    profileError,
    lookingUp,
    recomputing,
    profileSegment,
    profileLimit,
    profileRows,
    profilesError,
    profilesLoading,
    refresh: () => void loadOverview(),
    retryProfiles: () => void loadProfiles(profileSegment, profileLimit),
    updateEmail,
    lookup,
    recompute,
    setProfileSegment,
    setProfileLimit: (value: number): void => {
      if (isProfileLimit(value)) setProfileLimitState(value);
    },
  };
}

export type RFMSectionController = ReturnType<typeof useRFMSectionController>;
