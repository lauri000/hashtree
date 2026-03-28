import NDK, { NDKEvent, NDKPrivateKeySigner, NDKSubscription } from "ndk";
import { beforeAll, describe, expect, it, vi } from "vitest";
import NDKCacheAdapterDexie from "../src/index.js";

const ndk = new NDK();
ndk.signer = NDKPrivateKeySigner.generate();
ndk.cacheAdapter = new NDKCacheAdapterDexie();

describe("foundEvents", () => {
    it("applies limit filter", async () => {
        const startTime = Math.floor(Date.now() / 1000);
        const times: number[] = [];
        for (let i = 0; i < 10; i++) {
            const event = new NDKEvent(ndk);
            event.kind = 2;
            event.created_at = startTime - i * 60;
            times.push(event.created_at);
            await event.sign();
            await ndk.cacheAdapter?.setEvent(event, []);
        }

        const subscription = new NDKSubscription(ndk, [{ kinds: [2], limit: 2 }]);
        const spy = vi.spyOn(subscription, "eventReceived");
        await ndk.cacheAdapter?.query(subscription);
        expect(subscription.eventReceived).toHaveBeenCalledTimes(2);
        expect(spy.mock.calls[0]?.[0].created_at).toBe(times[0]);
        expect(spy.mock.calls[1]?.[0].created_at).toBe(times[1]);
    });
});

describe("foundEvent", () => {
    beforeAll(async () => {
        const event = new NDKEvent(ndk);
        event.kind = 1;
        event.tags.push(["a", "123"]);
        await event.sign();
        await ndk.cacheAdapter?.setEvent(event, []);
    });

    it("avoids reporting events that do not fully match the filter", async () => {
        const subscription = new NDKSubscription(ndk, [{ "#a": ["123"], "#t": ["hello"] }]);
        const spy = vi.spyOn(subscription, "eventReceived");
        await ndk.cacheAdapter?.query(subscription);
        expect(spy).toHaveBeenCalledTimes(0);
    });

    it("reports events that fully match the filter", async () => {
        const subscription = new NDKSubscription(ndk, [{ "#a": ["123"] }]);
        const spy = vi.spyOn(subscription, "eventReceived");
        await ndk.cacheAdapter?.query(subscription);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});

describe("by kind filter", () => {
    beforeAll(async () => {
        const event = new NDKEvent(ndk);
        event.kind = 10002;
        await event.sign();
        await ndk.cacheAdapter?.setEvent(event, []);
    });

    it("returns an event when fetching by kind", async () => {
        const subscription = new NDKSubscription(ndk, [{ kinds: [10002] }]);
        const spy = vi.spyOn(subscription, "eventReceived");
        await ndk.cacheAdapter?.query(subscription);
        expect(spy).toHaveBeenCalledTimes(1);
    });

    it("matches by kind even when there is a since filter", async () => {
        const subscription = new NDKSubscription(ndk, [{ kinds: [10002], since: 1000 }]);
        const spy = vi.spyOn(subscription, "eventReceived");
        await ndk.cacheAdapter?.query(subscription);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});
