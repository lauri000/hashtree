export function isGeneratedPlaylistVideoId(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^video_\d{6,}$/i.test(value.trim());
}

export function getInitialPlaylistItemTitle(itemId: string): string {
  return isGeneratedPlaylistVideoId(itemId) ? '' : itemId;
}

export function getVideoDisplayTitle(options: {
  videoTitle?: string | null;
  playlistItemTitle?: string | null;
  currentVideoId?: string | null;
  videoPath?: string | null;
  treeName?: string | null;
}): string {
  const explicitTitle = options.videoTitle?.trim();
  if (explicitTitle) return explicitTitle;

  const currentVideoId = options.currentVideoId?.trim();
  const playlistItemTitle = options.playlistItemTitle?.trim();
  if (playlistItemTitle && (!currentVideoId || playlistItemTitle !== currentVideoId || isGeneratedPlaylistVideoId(currentVideoId))) {
    return playlistItemTitle;
  }

  if (currentVideoId && !isGeneratedPlaylistVideoId(currentVideoId)) {
    return currentVideoId;
  }

  const videoPath = options.videoPath?.trim();
  if (videoPath) return videoPath;

  const treeName = options.treeName?.trim();
  if (treeName) {
    return treeName.startsWith('videos/') ? treeName.slice(7) : treeName;
  }

  return 'Video';
}
