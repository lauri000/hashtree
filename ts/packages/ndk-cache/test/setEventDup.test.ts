import NDK, { NDKEvent } from "ndk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../src/db";
import NDKCacheAdapterDexie from "../src/index";

describe("setEventDup", () => {
    let adapter: NDKCacheAdapterDexie;
    let ndk: NDK;

    beforeEach(async () => {
        ndk = new NDK();
        adapter = new NDKCacheAdapterDexie({
            dbName: "test-setEventDup-" + Math.random().toString(36),
        });
        await new Promise<void>((resolve) => {
            if (adapter.ready) {
                resolve();
            } else {
                adapter.onReady(() => resolve());
            }
        });
    });

    afterEach(async () => {
        if (db) {
            await db.delete();
        }
    });

    it("adds relays to an existing event", async () => {
        const event = new NDKEvent(ndk);
        event.id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        event.pubkey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        event.created_at = Math.floor(Date.now() / 1000);
        event.kind = 1;
        event.content = "Test event";
        event.tags = [];
        event.sig =
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

        const relay1 = { url: "wss://relay1.example.com" } as any;
        const relay2 = { url: "wss://relay2.example.com" } as any;
        const relay3 = { url: "wss://relay3.example.com" } as any;

        await adapter.setEvent(event, [], relay1);
        adapter.setEventDup(event, relay2);
        adapter.setEventDup(event, relay3);

        await new Promise((resolve) => setTimeout(resolve, 100));

        const relays = await db.eventRelays.where({ eventId: event.id }).toArray();
        expect(relays).toHaveLength(3);
        const relayUrls = relays.map((record) => record.relayUrl);
        expect(relayUrls).toContain("wss://relay1.example.com");
        expect(relayUrls).toContain("wss://relay2.example.com");
        expect(relayUrls).toContain("wss://relay3.example.com");
    });

    it("deduplicates repeated relay associations", async () => {
        const event = new NDKEvent(ndk);
        event.id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        event.pubkey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        event.created_at = Math.floor(Date.now() / 1000);
        event.kind = 1;
        event.content = "Test";
        event.tags = [];
        event.sig =
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

        const relay = { url: "wss://relay.example.com" } as any;

        await adapter.setEvent(event, [], relay);
        adapter.setEventDup(event, relay);
        adapter.setEventDup(event, relay);

        await new Promise((resolve) => setTimeout(resolve, 100));

        const relays = await db.eventRelays.where({ eventId: event.id, relayUrl: "wss://relay.example.com" }).toArray();
        expect(relays).toHaveLength(1);
    });

    it("creates a relay association even if the event is not present", async () => {
        const event = new NDKEvent(ndk);
        event.id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        const relay = { url: "wss://relay.example.com" } as any;

        expect(() => adapter.setEventDup(event, relay)).not.toThrow();

        await new Promise((resolve) => setTimeout(resolve, 100));

        const relays = await db.eventRelays.where({ eventId: event.id }).toArray();
        expect(relays).toHaveLength(1);
        expect(relays[0]?.relayUrl).toBe("wss://relay.example.com");
    });

    it("preserves every distinct relay URL", async () => {
        const event = new NDKEvent(ndk);
        event.id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        event.pubkey = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        event.created_at = Math.floor(Date.now() / 1000);
        event.kind = 1;
        event.content = "Test relay preservation";
        event.tags = [];
        event.sig =
            "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

        const relay1 = { url: "wss://relay1.example.com/" } as any;
        const relay2 = { url: "wss://relay2.example.com/" } as any;
        const relay3 = { url: "wss://relay3.example.com/" } as any;

        await adapter.setEvent(event, [], relay1);
        adapter.setEventDup(event, relay2);
        adapter.setEventDup(event, relay3);

        await new Promise((resolve) => setTimeout(resolve, 100));

        const relays = await db.eventRelays.where({ eventId: event.id }).toArray();
        expect(relays).toHaveLength(3);
        const relayUrls = relays.map((record) => record.relayUrl);
        expect(relayUrls).toContain("wss://relay1.example.com/");
        expect(relayUrls).toContain("wss://relay2.example.com/");
        expect(relayUrls).toContain("wss://relay3.example.com/");
    });
});
