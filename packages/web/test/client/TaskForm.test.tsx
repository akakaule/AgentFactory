import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskForm } from '../../client/src/components/TaskForm.js';

describe('TaskForm (create mode)', () => {
  it('calls onSubmit with the filled fields', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByPlaceholderText('Task title'), 'My new task');
    await user.type(screen.getByPlaceholderText('Describe the task…'), 'Do something cool');
    await user.type(screen.getByPlaceholderText('Define done…'), 'It works');

    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'My new task',
      spec: 'Do something cool',
      acceptanceCriteria: 'It works',
    });
  });

  it('does not call onSubmit when fields are empty', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('All fields are required.')).toBeInTheDocument();
  });

  it('does not call onSubmit when only some fields are filled', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByPlaceholderText('Task title'), 'My task');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={vi.fn()} onCancel={onCancel} />);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
  });
});

describe('TaskForm (edit mode)', () => {
  it('prefills fields from initial and calls onSubmit with updated values', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskForm
        mode="edit"
        initial={{ title: 'Old title', spec: 'Old spec', acceptanceCriteria: 'Old AC' }}
        onSubmit={onSubmit}
      />
    );

    const titleInput = screen.getByDisplayValue('Old title');
    await user.clear(titleInput);
    await user.type(titleInput, 'New title');

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'New title',
      spec: 'Old spec',
      acceptanceCriteria: 'Old AC',
    });
  });
});
