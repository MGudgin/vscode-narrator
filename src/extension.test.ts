import { describe, test, expect } from 'vitest';
import { isValidRange } from './extension';

describe('isValidRange', () => {
    test('rejects null', () => {
        expect(isValidRange(null)).toBe(false);
    });

    test('rejects undefined', () => {
        expect(isValidRange(undefined)).toBe(false);
    });

    test('rejects an empty object', () => {
        expect(isValidRange({})).toBe(false);
    });

    test('rejects when start is null', () => {
        expect(isValidRange({ start: null, end: { line: 0, character: 0 } })).toBe(false);
    });

    test('rejects when end is null', () => {
        expect(isValidRange({ start: { line: 0, character: 0 }, end: null })).toBe(false);
    });

    test('rejects when start.line is a string', () => {
        expect(isValidRange({
            start: { line: 'x', character: 0 },
            end: { line: 0, character: 0 },
        })).toBe(false);
    });

    test('rejects when start.character is missing', () => {
        expect(isValidRange({
            start: { line: 0 },
            end: { line: 0, character: 0 },
        })).toBe(false);
    });

    test('rejects when end.line is NaN', () => {
        expect(isValidRange({
            start: { line: 0, character: 0 },
            end: { line: NaN, character: 0 },
        })).toBe(false);
    });

    test('rejects when a coordinate is Infinity', () => {
        expect(isValidRange({
            start: { line: 0, character: 0 },
            end: { line: Infinity, character: 0 },
        })).toBe(false);
    });

    test('rejects a primitive', () => {
        expect(isValidRange('hello')).toBe(false);
        expect(isValidRange(42)).toBe(false);
        expect(isValidRange(true)).toBe(false);
    });

    test('accepts a well-formed range', () => {
        expect(isValidRange({
            start: { line: 0, character: 0 },
            end: { line: 10, character: 25 },
        })).toBe(true);
    });

    test('accepts a zero-width range', () => {
        expect(isValidRange({
            start: { line: 3, character: 7 },
            end: { line: 3, character: 7 },
        })).toBe(true);
    });
});
