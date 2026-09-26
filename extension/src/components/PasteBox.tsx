import { useState } from 'react';
import { Button, Group, Stack, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconClipboardText, IconPlayerPlayFilled } from '@tabler/icons-react';
import { player } from '../hooks/usePlayer';

/** "Paste text & read": a textarea plus clipboard paste, played through the engine. */
export function PasteBox({
  minRows = 3,
  maxRows = 6,
  disabled = false,
}: {
  minRows?: number;
  maxRows?: number;
  disabled?: boolean;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const read = async (value: string) => {
    const t = value.trim();
    if (!t) return;
    setBusy(true);
    const res = await player.play({ text: t, title: 'Pasted text' });
    setBusy(false);
    if (res && res.ok === false) {
      notifications.show({
        color: 'red',
        title: 'Could not start reading',
        message: res.error ?? '',
      });
    }
  };

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip.trim()) {
        setText(clip);
        void read(clip);
      }
    } catch {
      notifications.show({
        color: 'yellow',
        title: 'Clipboard not available',
        message: 'Paste into the box with Ctrl+V (⌘V), then press Read.',
      });
    }
  };

  return (
    <Stack gap={6}>
      <Textarea
        aria-label="Text to read"
        placeholder="Paste or type text to read aloud…"
        autosize
        minRows={minRows}
        maxRows={maxRows}
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void read(text);
        }}
      />
      <Group justify="space-between" gap="xs">
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconClipboardText size={14} />}
          onClick={() => void paste()}
          disabled={disabled}
        >
          Read clipboard
        </Button>
        <Group gap={6}>
          <Text size="xs" c="dimmed">
            {text.length ? `${text.length.toLocaleString()} chars` : ''}
          </Text>
          <Button
            size="xs"
            variant="gradient"
            leftSection={<IconPlayerPlayFilled size={12} />}
            loading={busy}
            disabled={disabled || !text.trim()}
            onClick={() => void read(text)}
          >
            Read
          </Button>
        </Group>
      </Group>
    </Stack>
  );
}
