import { describe, expect, it } from 'vitest';
import type { NodeStatus } from '@simrs-flow/workflow-core';
import { cameraTargetNode } from './WorkflowCanvas.js';

const node = (id: string, status: NodeStatus) => ({ id, data: { status } });

describe('cameraTargetNode', () => {
  it('prefers a waiting gate over a running node', () => {
    expect(cameraTargetNode([node('active', 'running'), node('gate', 'gate_waiting')])?.id).toBe('gate');
  });
  it('prefers a running node over a completed frontier', () => {
    expect(cameraTargetNode([node('done', 'success'), node('active', 'running'), node('next', 'pending')])?.id).toBe('active');
  });

  it('chooses the furthest reached node when nothing is running', () => {
    expect(cameraTargetNode([node('first', 'success'), node('last', 'needs_review'), node('next', 'queued')])?.id).toBe('last');
    expect(cameraTargetNode([node('first', 'success'), node('last', 'success'), node('next', 'pending')])?.id).toBe('last');
  });

  it('centers the first node before progress, and handles an empty graph', () => {
    expect(cameraTargetNode([node('first', 'pending'), node('next', 'queued')])?.id).toBe('first');
    expect(cameraTargetNode([])).toBeUndefined();
  });
});
