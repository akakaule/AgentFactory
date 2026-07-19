import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskForm } from '../../client/src/components/TaskForm.js';

vi.mock('../../client/src/image.js', () => ({
  downscalePastedImage: vi.fn().mockResolvedValue({ mime: 'image/png', dataBase64: 'QUJD' }),
}));

const pasteImage = (target: Element, filename = 'shot.png') =>
  fireEvent.paste(target, {
    clipboardData: {
      items: [{ type: 'image/png', getAsFile: () => new File([new Uint8Array([1, 2, 3])], filename, { type: 'image/png' }) }],
    },
  });

describe('TaskForm (create mode)', () => {
  it('defaults to the full pipeline: AC optional, stage description submitted', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    await user.type(screen.getByPlaceholderText('Task title'), 'My new task');
    await user.type(screen.getByPlaceholderText('Describe the task…'), 'Do something cool');

    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'My new task',
      spec: 'Do something cool',
      stage: 'description',
    }, [], []);
  });

  it('implementation-only requires acceptance criteria and submits stage implementation', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    await user.selectOptions(screen.getByLabelText('Workflow'), 'implementation');
    await user.type(screen.getByPlaceholderText('Task title'), 'My new task');
    await user.type(screen.getByPlaceholderText('Describe the task…'), 'Do something cool');

    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(onSubmit).not.toHaveBeenCalled(); // AC required outside the pipeline

    await user.type(screen.getByPlaceholderText('Define done…'), 'It works');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'My new task',
      spec: 'Do something cool',
      acceptanceCriteria: 'It works',
      stage: 'implementation',
    }, [], []);
  });

  it('does not call onSubmit when fields are empty', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Title and spec are required.')).toBeInTheDocument();
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

describe('TaskForm image paste', () => {
  it('pasting an image shows a removable thumbnail and submits it', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    pasteImage(screen.getByPlaceholderText('Describe the task…'));
    expect(await screen.findByAltText('shot.png')).toHaveAttribute('src', 'data:image/png;base64,QUJD');

    await user.type(screen.getByPlaceholderText('Task title'), 'T');
    await user.type(screen.getByPlaceholderText('Describe the task…'), 'S');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'T' }),
      [{ filename: 'shot.png', mime: 'image/png', dataBase64: 'QUJD' }],
      [],
    );
  });

  it('the ✕ removes a pending image before submit', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(<TaskForm mode="create" onSubmit={onSubmit} />);

    pasteImage(screen.getByPlaceholderText('Describe the task…'));
    await screen.findByAltText('shot.png');
    await user.click(screen.getByRole('button', { name: 'Remove shot.png' }));
    expect(screen.queryByAltText('shot.png')).not.toBeInTheDocument();
  });

  it('edit mode lists existing attachments and collects removals', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskForm
        mode="edit"
        initial={{
          title: 'T', spec: 'S', acceptanceCriteria: 'A',
          attachments: [{ id: 7, taskId: 1, filename: 'old.png', mime: 'image/png', size: 10 }],
        }}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByAltText('old.png')).toHaveAttribute('src', '/api/attachments/7');
    await user.click(screen.getByRole('button', { name: 'Remove old.png' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.anything(), [], [7]);
  });
});

describe('TaskForm workspace picker', () => {
  it('renders a dropdown with multiple workspaces and submits the chosen one', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskForm mode="create" onSubmit={onSubmit} workspaces={['default', 'repo-a']} initialWorkspace="default" />,
    );

    await user.selectOptions(screen.getByLabelText('Workspace'), 'repo-a');
    await user.type(screen.getByPlaceholderText('Task title'), 'T');
    await user.type(screen.getByPlaceholderText('Describe the task…'), 'S');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ workspace: 'repo-a' }), [], []);
  });

  it('hides the dropdown when only one workspace exists', () => {
    render(<TaskForm mode="create" onSubmit={vi.fn()} workspaces={['default']} />);
    expect(screen.queryByLabelText('Workspace')).not.toBeInTheDocument();
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
    }, [], []);
  });

  it('preselects the current workspace and submits a different one', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    render(
      <TaskForm
        mode="edit"
        initial={{ title: 'T', spec: 'S', acceptanceCriteria: 'A' }}
        workspaces={['default', 'repo-a', 'repo-b']}
        initialWorkspace="repo-a"
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByLabelText('Workspace')).toHaveValue('repo-a');
    await user.selectOptions(screen.getByLabelText('Workspace'), 'repo-b');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: 'T', spec: 'S', acceptanceCriteria: 'A', workspace: 'repo-b',
    }, [], []);
  });
});

describe('TaskForm submit failure feedback', () => {
  it('surfaces a rejected submit instead of leaving a dead button', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error('422: workspace not found'));
    render(<TaskForm mode="create" onSubmit={onSubmit} onCancel={vi.fn()} />);

    // mirror the reported case: implementation-only task with all fields filled
    await user.selectOptions(screen.getByLabelText('Workflow'), 'implementation');
    await user.type(screen.getByPlaceholderText('Task title'), 'Update to Aspire 13.4.4');
    await user.type(screen.getByPlaceholderText('Describe the task…'), 'Update to Aspire 13.4.4');
    await user.type(screen.getByPlaceholderText('Define done…'), 'Aspire updated');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    // previously this rejection vanished and the button just sat there; now it's shown
    expect(await screen.findByText('422: workspace not found')).toBeInTheDocument();
    // and the button is interactive again so the user can retry
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('disables the button while a submit is in flight (no double-submit)', async () => {
    const user = userEvent.setup();
    let resolve: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    render(<TaskForm mode="create" onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByPlaceholderText('Task title'), 'T');
    await user.type(screen.getByPlaceholderText('Describe the task…'), 'S');
    await user.click(screen.getByRole('button', { name: 'Create' }));

    const busy = screen.getByRole('button', { name: 'Creating…' });
    expect(busy).toBeDisabled();
    await user.click(busy); // ignored while in flight
    expect(onSubmit).toHaveBeenCalledTimes(1);
    resolve();
  });
});
