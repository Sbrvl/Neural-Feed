// tests/test_queue.js — Vitest unit tests for FIFO reel queue logic
// Run: cd tests && npm test

import { describe, it, expect, beforeEach } from 'vitest';

// ── Inline queue implementation matching service_worker.js logic ──────────────
// (Extracted for testability — service_worker.js imports constants.js which
// references chrome.* APIs not available in Node. We test the pure logic here.)

const QUEUE_MAX_DEPTH = 3;

function makeQueue() {
  const queue = [];

  function enqueue(reelMeta) {
    let dropped = null;
    if (queue.length >= QUEUE_MAX_DEPTH) {
      dropped = queue.shift();
    }
    queue.push(reelMeta);
    return dropped;
  }

  function dequeue(reelId) {
    const idx = queue.findIndex(r => r.reelId === reelId);
    if (idx === -1) return null;
    const [item] = queue.splice(idx, 1);
    return item;
  }

  function getQueue() {
    return [...queue];
  }

  return { enqueue, dequeue, getQueue };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('FIFO reel queue', () => {

  it('enqueues reels up to max depth', () => {
    const q = makeQueue();
    q.enqueue({ reelId: 'r1' });
    q.enqueue({ reelId: 'r2' });
    q.enqueue({ reelId: 'r3' });
    expect(q.getQueue()).toHaveLength(3);
  });

  it('drops oldest reel when queue is full', () => {
    const q = makeQueue();
    q.enqueue({ reelId: 'r1' });
    q.enqueue({ reelId: 'r2' });
    q.enqueue({ reelId: 'r3' });
    const dropped = q.enqueue({ reelId: 'r4' });

    expect(dropped).toEqual({ reelId: 'r1' });
    expect(q.getQueue().map(r => r.reelId)).toEqual(['r2', 'r3', 'r4']);
  });

  it('queue length never exceeds max depth', () => {
    const q = makeQueue();
    for (let i = 0; i < 10; i++) {
      q.enqueue({ reelId: `r${i}` });
    }
    expect(q.getQueue()).toHaveLength(QUEUE_MAX_DEPTH);
  });

  it('dequeues by reelId (in-order)', () => {
    const q = makeQueue();
    q.enqueue({ reelId: 'r1', platform: 'instagram' });
    q.enqueue({ reelId: 'r2', platform: 'tiktok' });

    const item = q.dequeue('r1');
    expect(item).toEqual({ reelId: 'r1', platform: 'instagram' });
    expect(q.getQueue()).toHaveLength(1);
  });

  it('dequeues by reelId (out-of-order)', () => {
    const q = makeQueue();
    q.enqueue({ reelId: 'r1' });
    q.enqueue({ reelId: 'r2' });
    q.enqueue({ reelId: 'r3' });

    // Result arrives out of order — r3 first
    const item = q.dequeue('r3');
    expect(item).toEqual({ reelId: 'r3' });
    expect(q.getQueue().map(r => r.reelId)).toEqual(['r1', 'r2']);
  });

  it('returns null for unknown reelId', () => {
    const q = makeQueue();
    q.enqueue({ reelId: 'r1' });
    const item = q.dequeue('does-not-exist');
    expect(item).toBeNull();
  });

  it('does not mutate queue when dequeue misses', () => {
    const q = makeQueue();
    q.enqueue({ reelId: 'r1' });
    q.dequeue('unknown');
    expect(q.getQueue()).toHaveLength(1);
  });

});
