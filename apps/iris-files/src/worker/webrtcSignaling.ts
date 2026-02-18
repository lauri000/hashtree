/**
 * WebRTC Signaling Handler for Hashtree Worker
 *
 * Handles WebRTC signaling via Nostr (kind 25050).
 * - Hello messages: broadcast with #l tag for peer discovery
 * - Directed messages (offer/answer/candidates): gift-wrapped for privacy
 */

import type { SignedEvent } from './protocol';
import type { SignalingMessage } from '@hashtree/nostr';
import type { WebRTCController } from './webrtc';
import {
  createSignalingFilters,
  decodeSignalingEvent,
  sendSignalingMessage,
} from '@hashtree/worker/p2p';
import { subscribe as ndkSubscribe, publish as ndkPublish } from './ndk';
import { signEvent, giftWrap, giftUnwrap } from './signing';

let webrtc: WebRTCController | null = null;
let signalingPubkey: string | null = null;

/**
 * Initialize the WebRTC signaling handler
 */
export function initWebRTCSignaling(controller: WebRTCController): void {
  webrtc = controller;
}

/**
 * Send WebRTC signaling message via Nostr (kind 25050)
 * - Hello messages: broadcast with #l tag
 * - Directed messages (offer/answer/candidates): gift-wrapped
 */
export async function sendWebRTCSignaling(
  msg: SignalingMessage,
  recipientPubkey?: string
): Promise<void> {
  try {
    await sendSignalingMessage<SignedEvent>({
      msg,
      recipientPubkey,
      signEvent,
      giftWrap,
      publish: ndkPublish,
    });
  } catch (err) {
    console.error('[Worker] Failed to send WebRTC signaling:', err);
  }
}

/**
 * Subscribe to WebRTC signaling events.
 * NOTE: The caller must set up the event handler via setOnEvent
 * and route webrtc-* subscriptions to handleWebRTCSignalingEvent.
 */
export function setupWebRTCSignalingSubscription(myPubkey: string): void {
  signalingPubkey = myPubkey;
  const { since, helloFilter, directedFilter } = createSignalingFilters(myPubkey);

  console.log('[WebRTC Signaling] Setting up subscriptions for', myPubkey.slice(0, 16), 'since', since);

  // Subscribe to hello messages (broadcast discovery)
  console.log('[WebRTC Signaling] Creating webrtc-hello subscription');
  ndkSubscribe('webrtc-hello', [helloFilter]);

  // Subscribe to directed signaling (offers/answers to us)
  console.log('[WebRTC Signaling] Creating webrtc-directed subscription');
  ndkSubscribe('webrtc-directed', [directedFilter]);

  console.log('[WebRTC Signaling] Subscriptions setup complete');
}

/**
 * Re-subscribe to WebRTC signaling after relay change.
 * Call this after setRelays to ensure subscriptions work on new relays.
 */
export function resubscribeWebRTCSignaling(): void {
  if (!signalingPubkey) {
    console.warn('[WebRTC Signaling] Cannot resubscribe - no pubkey set');
    return;
  }
  console.log('[WebRTC Signaling] Resubscribing with pubkey:', signalingPubkey.slice(0, 16));
  setupWebRTCSignalingSubscription(signalingPubkey);
  console.log('[WebRTC Signaling] Resubscription complete');
}

/**
 * Handle incoming WebRTC signaling event.
 * Call this from the unified NostrManager event handler for webrtc-* subscriptions.
 */
export async function handleWebRTCSignalingEvent(event: SignedEvent): Promise<void> {
  const decoded = await decodeSignalingEvent({
    event,
    giftUnwrap,
  });

  if (!decoded) {
    return;
  }

  if (decoded.message.type !== 'hello') {
    console.log('[WebRTC] Unwrapped message:', decoded.message.type, 'from', decoded.senderPubkey.slice(0, 8));
  }

  webrtc?.handleSignalingMessage(decoded.message, decoded.senderPubkey);
}
