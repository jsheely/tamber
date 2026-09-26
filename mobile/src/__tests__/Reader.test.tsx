import { planChunks } from '@tamber/client';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';

import { Reader } from '@/reader/Reader';
import { buildParagraphs, countLineBreaks, paragraphText } from '@/reader/layout';

import { chunkEvent } from './helpers/fakeServer';

const TEXT =
  '  Why Voices Matter\n\nThe first paragraph, with “quotes” and an emoji 🎧. It has two sentences!\nA hard-wrapped line continues it.\n\n***\n\nThe last paragraph ends here.  ';

/** Concatenate every string rendered under a node (nested <Text> spans). */
function flatText(node: TestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map((c) => flatText(c)).join('');
}

describe('reader layout', () => {
  it('counts line breaks like the server', () => {
    expect(countLineBreaks('a\r\nb')).toBe(1);
    expect(countLineBreaks('\n\n')).toBe(2);
    expect(countLineBreaks(' ')).toBe(2);
    expect(countLineBreaks(' \t ')).toBe(0);
  });

  it('accounts for every non-whitespace character of the text, in order', () => {
    const plan = planChunks(TEXT, { mode: 'balanced' });
    const paragraphs = buildParagraphs(TEXT, plan);
    // Chunks never cross paragraphs; "***" is its own plain paragraph.
    expect(paragraphs.map((p) => paragraphText(TEXT, p))).toEqual([
      'Why Voices Matter',
      'The first paragraph, with “quotes” and an emoji 🎧. It has two sentences!\nA hard-wrapped line continues it.',
      '***',
      'The last paragraph ends here.',
    ]);
    const rebuilt = paragraphs.map((p) => paragraphText(TEXT, p)).join('\n\n');
    expect(rebuilt).toBe(TEXT.trim());
  });
});

describe('<Reader>', () => {
  const plan = planChunks(TEXT, { mode: 'sentence' });

  it('renders the exact submitted text', async () => {
    await render(
      <Reader
        text={TEXT}
        plan={plan}
        chunkWords={{}}
        activeChunk={-1}
        activeWord={-1}
        highlightWords
        autoScroll
        onSeek={() => undefined}
      />,
    );
    const paragraphs = buildParagraphs(TEXT, plan);
    for (const p of paragraphs) {
      const node = screen.getByTestId(`para-${p.key}`);
      expect(flatText(node)).toBe(paragraphText(TEXT, p));
    }
  });

  it('renders word spans once timings arrive and seeks on tap', async () => {
    const onSeek = jest.fn();
    const second = plan[1]!;
    const words = chunkEvent(TEXT, second).words;
    await render(
      <Reader
        text={TEXT}
        plan={plan}
        chunkWords={{ [second.index]: words }}
        activeChunk={second.index}
        activeWord={1}
        highlightWords
        autoScroll={false}
        onSeek={onSeek}
      />,
    );
    const target = words[3]!;
    await fireEvent.press(screen.getByText(target.text));
    expect(onSeek).toHaveBeenCalledWith(target.char_start);
    // Text is unchanged by the spans.
    const para = buildParagraphs(TEXT, plan).find((p) => p.chunkIndices.includes(second.index))!;
    expect(flatText(screen.getByTestId(`para-${para.key}`))).toBe(paragraphText(TEXT, para));
  });
});
