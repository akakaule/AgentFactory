import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VisualizationSection } from '../../client/src/components/VisualizationSection.js';

vi.mock('../../client/src/api.js', () => ({
  api: { getVisualizationHtml: vi.fn() },
}));

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as { getVisualizationHtml: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  (await getApiMock()).getVisualizationHtml.mockReset();
});

describe('VisualizationSection', () => {
  it('renders nothing when the task has no visualization', () => {
    const { container } = render(<VisualizationSection taskKey="AF-7" present={false} generatedAt={null} />);
    expect(screen.queryByText('Change visualization')).not.toBeInTheDocument();
    expect(container.querySelector('.af-tx-row')).toBeNull();
  });

  it('shows a View button when present, with the HTML NOT fetched until opened', async () => {
    const mocked = await getApiMock();
    render(<VisualizationSection taskKey="AF-7" present={true} generatedAt="2026-06-29T00:00:00.000Z" />);

    expect(screen.getByText('Change visualization')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View visualization' })).toBeInTheDocument();
    expect(mocked.getVisualizationHtml).not.toHaveBeenCalled();
  });

  it('opens a modal that fetches + frames the HTML when View visualization is clicked', async () => {
    const mocked = await getApiMock();
    mocked.getVisualizationHtml.mockResolvedValue('<html><body>flow</body></html>');
    const user = userEvent.setup();

    render(<VisualizationSection taskKey="AF-7" present={true} generatedAt={null} />);
    await user.click(screen.getByRole('button', { name: 'View visualization' }));

    expect(await screen.findByRole('dialog', { name: 'Change visualization' })).toBeInTheDocument();
    expect(mocked.getVisualizationHtml).toHaveBeenCalledWith('AF-7');

    // the iframe mounts only after the HTML fetch resolves
    const frame = await screen.findByTitle('Change visualization');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect((frame as HTMLIFrameElement).getAttribute('srcdoc')).toContain('flow');
  });
});
