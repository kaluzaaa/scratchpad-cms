export const PODCAST_IDS = ["podcast-a", "podcast-b"] as const;

export type PodcastId = (typeof PODCAST_IDS)[number];

export type AccessLevel = "RO" | "RW";

// Static access map: user -> podcast -> highest granted level (RW implies RO).
export const permissions: Record<
  string,
  Partial<Record<PodcastId, AccessLevel>>
> = {
  alice: { "podcast-a": "RW", "podcast-b": "RO" },
  bob: { "podcast-b": "RW" },
};

export const isKnownPodcast = (id: string): id is PodcastId =>
  (PODCAST_IDS as readonly string[]).includes(id);

export const isKnownUser = (user: string): boolean => user in permissions;

export const canAccess = (
  user: string,
  podcastId: PodcastId,
  level: AccessLevel,
): boolean => {
  const grant = permissions[user]?.[podcastId];
  if (grant === undefined) return false;
  return grant === "RW" || level === "RO";
};
