export {
  WebRTCController,
  type WebRTCControllerConfig,
} from './webrtcController.js';

export {
  WebRTCProxy,
  initWebRTCProxy,
  getWebRTCProxy,
  closeWebRTCProxy,
} from './webrtcProxy.js';

export type {
  WebRTCCommand,
  WebRTCEvent,
} from './protocol.js';

export {
  SIGNALING_KIND,
  HELLO_TAG,
  MAX_EVENT_AGE_SEC,
  createSignalingFilters,
  sendSignalingMessage,
  decodeSignalingEvent,
} from './signaling.js';

export type {
  SignalingEventLike,
  GiftSeal,
  SignalingTemplate,
  SignalingInnerEvent,
  SignalingFilters,
  DecodedSignalingEvent,
} from './signaling.js';
