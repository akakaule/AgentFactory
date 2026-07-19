import { describe, it, expect } from 'vitest';
import { parse, createTaskSchema, updateTaskSchema, submitResultSchema } from '../src/validate.js';
import { ValidationError } from '../src/errors.js';

describe('validate', () => {
  it('parses a valid createTask input', () => {
    expect(parse(createTaskSchema, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }))
      .toEqual({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  });
  it('throws ValidationError on empty fields', () => {
    expect(() => parse(createTaskSchema, { title: '', spec: 'S', acceptanceCriteria: 'A' })).toThrow(ValidationError);
  });
  it('updateTask requires at least one field', () => {
    expect(() => parse(updateTaskSchema, {})).toThrow(ValidationError);
    expect(parse(updateTaskSchema, { title: 'X' })).toEqual({ title: 'X' });
    expect(parse(updateTaskSchema, { workspace: 'repo-b' })).toEqual({ workspace: 'repo-b' });
    expect(() => parse(updateTaskSchema, { workspace: 'Repo B' })).toThrow(ValidationError);
  });
  it('submitResult defaults links to []', () => {
    expect(parse(submitResultSchema, { summary: 'done' })).toEqual({ summary: 'done', links: [] });
  });
});
