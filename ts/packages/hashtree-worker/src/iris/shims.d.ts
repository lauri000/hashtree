declare module 'ndk' {
  const NDK: any;
  export default NDK;
  export const NDKEvent: any;
  export const NDKPrivateKeySigner: any;
  export type NDKFilter = any;
}

declare module 'ndk-cache' {
  const NDKCacheAdapterDexie: any;
  export default NDKCacheAdapterDexie;
}

declare module 'nostr-social-graph' {
  export const SocialGraph: any;
  export type NostrEvent = any;
}
