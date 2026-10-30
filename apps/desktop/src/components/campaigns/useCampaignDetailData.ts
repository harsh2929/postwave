import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";

import {
  type ArchiveTenantSettings,
  type Campaign,
  type CampaignDetail,
  type CampaignReport,
  api,
} from "../../lib/api-client";
import { isExactStrongCampaignETag } from "../../lib/api/campaign-assurance";
import { connectCampaignEvents, type SseStatus } from "../../lib/sse";

const ARCHIVE_PUBLIC_HOST = "https://archive.moosewave.com";

export function resolveCampaignArchiveBase(
  settings: ArchiveTenantSettings | null,
): string | null {
  if (!settings) return null;
  const domain = (settings.archive_domain ?? "").trim();
  if (domain) {
    return `https://${domain.replace(/^https?:\/\//i, "").replace(/\/+$/, "")}`;
  }
  const slug = (settings.tenant_archive_slug ?? "").trim();
  if (!slug) return null;
  return `${ARCHIVE_PUBLIC_HOST}/${encodeURIComponent(slug)}`;
}

export function asCampaignString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return String(value);
}

export function resolveCampaignFromEmail(detail: CampaignDetail): string {
  if (detail.from_email) return detail.from_email;
  const deliverySettings = (
    detail as { delivery_settings?: { from_email?: unknown } }
  ).delivery_settings;
  return typeof deliverySettings?.from_email === "string"
    ? deliverySettings.from_email
    : "";
}

export interface CampaignDetailData {
  id: Campaign["id"];
  detail: CampaignDetail;
  setDetail: Dispatch<SetStateAction<CampaignDetail>>;
  campaignETag: string | null;
  refreshDetail: () => void;
  savedFromEmail: string;
  loading: boolean;
  report: CampaignReport | null;
  reportErr: string | null;
  detailErr: string | null;
  archiveBase: string | null;
  archiveSettingsLoaded: boolean;
  status: string;
  isDraft: boolean;
  canPauseSend: boolean;
  canResumeSend: boolean;
  canCancelSend: boolean;
  hasReport: boolean;
  liveStatus: SseStatus;
}

export function useCampaignDetailData(campaign: Campaign): CampaignDetailData {
  const id = campaign.id;
  const [detail, setDetail] = useState<CampaignDetail>(() => ({ ...campaign }));
  const [campaignETag, setCampaignETag] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<CampaignReport | null>(null);
  const [reportErr, setReportErr] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [archiveBase, setArchiveBase] = useState<string | null>(null);
  const [archiveSettingsLoaded, setArchiveSettingsLoaded] = useState(false);
  const [liveStatus, setLiveStatus] = useState<SseStatus>("closed");
  const refreshDetail = useCallback(() => {
    setCampaignETag(null);
    setRefreshToken((value) => value + 1);
  }, []);

  useLayoutEffect(() => {
    // Every piece of detail state is identity-owned. Reset before paint so a
    // caller that ever reuses this hook cannot present A's detail under B's
    // id while B's requests are starting.
    setDetail({ ...campaign });
    setCampaignETag(null);
    setLoading(id != null);
    setReport(null);
    setReportErr(null);
    setDetailErr(null);
    setArchiveBase(null);
    setArchiveSettingsLoaded(false);
    setLiveStatus("closed");
  }, [campaign, id]);

  useEffect(() => {
    if (!detail.archive_public || !detail.archive_slug) return;
    let cancelled = false;
    void (async () => {
      const result = await api.getArchiveTenantSettings();
      if (cancelled) return;
      setArchiveSettingsLoaded(true);
      if (!result.error) {
        setArchiveBase(resolveCampaignArchiveBase(result.data ?? null));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detail.archive_public, detail.archive_slug]);

  useEffect(() => {
    let cancelled = false;
    if (id == null) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    void (async () => {
      const [detailResult, reportResult] = await Promise.all([
        api.getCampaign(id),
        api.getCampaignReport(id),
      ]);
      if (cancelled) return;
      if (detailResult.error) {
        setDetailErr(detailResult.error.message);
        setCampaignETag(null);
      } else if (detailResult.data) {
        setDetail(detailResult.data);
        setCampaignETag(strongETag(detailResult.serverVersion));
        setDetailErr(null);
      }
      setLoading(false);
      if (reportResult.error) {
        setReportErr(reportResult.error.message);
      } else if (reportResult.data) {
        setReport(reportResult.data);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, refreshToken]);

  const status = (detail.status ?? "draft").toLowerCase();
  const isDraft = status === "draft";
  const canPauseSend = status === "sending" || status === "scheduled";
  const canResumeSend = status === "paused";
  const canCancelSend =
    status === "sending" || status === "scheduled" || status === "paused";

  useEffect(() => {
    if (id == null || isDraft) return;
    const disconnect = connectCampaignEvents(
      id,
      (snapshot) => setReport(snapshot),
      undefined,
      (nextStatus) => setLiveStatus(nextStatus),
    );
    return () => {
      disconnect();
      setLiveStatus("closed");
    };
  }, [id, isDraft]);

  const hasReport = useMemo<boolean>(() => {
    if (!report) return false;
    return (
      (report.sent ?? 0) > 0 ||
      (report.delivered ?? 0) > 0 ||
      (report.opens ?? 0) > 0 ||
      (report.clicks ?? 0) > 0
    );
  }, [report]);

  return {
    id,
    detail,
    setDetail,
    campaignETag,
    refreshDetail,
    savedFromEmail: resolveCampaignFromEmail(detail),
    loading,
    report,
    reportErr,
    detailErr,
    archiveBase,
    archiveSettingsLoaded,
    status,
    isDraft,
    canPauseSend,
    canResumeSend,
    canCancelSend,
    hasReport,
    liveStatus,
  };
}

function strongETag(value: string | undefined): string | null {
  return isExactStrongCampaignETag(value) ? value : null;
}
