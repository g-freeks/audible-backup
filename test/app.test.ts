import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getArg } from '../app.ts';

describe('getArg', () => {
    it('returns the value following a flag', () => {
        const args = ['sync', '--dir', '/tmp/music', '--output', '/tmp/out'];
        assert.equal(getArg(args, '--dir'), '/tmp/music');
        assert.equal(getArg(args, '--output'), '/tmp/out');
    });

    it('returns undefined when flag is not present', () => {
        const args = ['sync', '--dir', '/tmp/music'];
        assert.equal(getArg(args, '--output'), undefined);
    });

    it('returns undefined when flag is last argument with no value', () => {
        const args = ['sync', '--dir'];
        assert.equal(getArg(args, '--dir'), undefined);
    });
});
