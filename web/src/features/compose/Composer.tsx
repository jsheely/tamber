import { Badge, Button, Group, Stack, Text, Textarea, Title, Tooltip } from '@mantine/core';
import { planChunks } from '@tamber/client';
import {
  IconClipboardText,
  IconFileImport,
  IconPlayerPlayFilled,
  IconX,
} from '@tabler/icons-react';
import { motion } from 'motion/react';
import { useDeferredValue, useEffect, useMemo, useRef } from 'react';
import { countWords, estimateSeconds, formatCount, formatDurationWords } from '../../lib/format';
import { startPlayback } from '../../player/actions';
import { useDraft } from '../../store/draft';
import { useSession } from '../../store/session';
import { useSettings } from '../../store/settings';
import classes from './Composer.module.css';

const canPaste = typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

/** Text entry: paste, import, clear, live stats and the chunk-plan hint. */
export function Composer() {
  const text = useDraft((s) => s.text);
  const setText = useDraft((s) => s.setText);
  const clear = useDraft((s) => s.clear);
  const importInfo = useDraft((s) => s.importInfo);
  const tooLarge = useDraft((s) => s.tooLargeToSave);
  const speed = useSettings((s) => s.speed);
  const chunkMode = useSettings((s) => s.chunkMode);
  const limits = useSession((s) => s.health?.limits);
  const openDrawer = useSession((s) => s.openDrawer);
  const focusComposer = useSession((s) => s.focusComposer);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Shift+N lands here with the field focused, ready for a paste.
  useEffect(() => {
    if (focusComposer) ref.current?.focus();
  }, [focusComposer]);

  const deferred = useDeferredValue(text);
  const stats = useMemo(() => {
    const chunks = deferred.trim()
      ? planChunks(deferred, {
          mode: chunkMode,
          targetChars: limits?.chunk_target_chars,
          maxChars: limits?.chunk_max_chars,
        }).length
      : 0;
    return {
      chars: deferred.length,
      words: countWords(deferred),
      chunks,
      seconds: estimateSeconds(deferred.length, speed),
    };
  }, [deferred, chunkMode, speed, limits?.chunk_target_chars, limits?.chunk_max_chars]);

  const overLimit = limits ? text.length > limits.max_text_chars : false;

  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip) return;
      const el = ref.current;
      if (el && text) {
        const start = el.selectionStart ?? text.length;
        const end = el.selectionEnd ?? text.length;
        setText(text.slice(0, start) + clip + text.slice(end));
      } else {
        setText(clip);
      }
    } catch {
      ref.current?.focus();
    }
  };

  return (
    <motion.section
      layoutId="tamber-surface"
      className={`tamber-surface ${classes.card}`}
      transition={{ type: 'spring', stiffness: 380, damping: 34 }}
      aria-labelledby="composer-title"
    >
      <Stack gap="sm">
        <Group justify="space-between" wrap="wrap" gap="xs">
          <Title order={2} id="composer-title" size="h4">
            What should I read?
          </Title>
          <Group gap={4} wrap="nowrap">
            {canPaste && (
              <Button
                variant="subtle"
                size="compact-md"
                h={40}
                leftSection={<IconClipboardText size={18} />}
                onClick={() => void paste()}
              >
                Paste
              </Button>
            )}
            <Button
              variant="subtle"
              size="compact-md"
              h={40}
              leftSection={<IconFileImport size={18} />}
              onClick={() => openDrawer('import')}
            >
              Import
            </Button>
            <Tooltip label="Clear text">
              <Button
                variant="subtle"
                color="gray"
                size="compact-md"
                h={40}
                px={10}
                aria-label="Clear text"
                disabled={!text}
                onClick={() => {
                  clear();
                  ref.current?.focus();
                }}
              >
                <IconX size={18} />
              </Button>
            </Tooltip>
          </Group>
        </Group>

        {importInfo && (
          <Group gap={6} wrap="wrap">
            {importInfo.title && (
              <Badge variant="light" size="lg" radius="sm" maw="100%" style={{ textTransform: 'none' }}>
                <Text span size="xs" fw={600} truncate>
                  {importInfo.title}
                </Text>
              </Badge>
            )}
            <Badge variant="outline" color="gray" radius="sm">
              {formatCount(importInfo.wordCount)} words
            </Badge>
            {importInfo.truncated && (
              <Tooltip label="The document was longer than the server's import limit">
                <Badge variant="light" color="yellow" radius="sm">
                  truncated
                </Badge>
              </Tooltip>
            )}
          </Group>
        )}

        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder="Paste an article, a chapter, an email… or import a web page or document."
          aria-label="Text to read"
          autosize
          minRows={7}
          maxRows={18}
          classNames={{ input: classes.input }}
          spellCheck
          data-testid="composer"
        />

        <Group justify="space-between" gap="sm" wrap="wrap">
          <Text size="xs" c="dimmed" aria-live="off" data-testid="composer-stats">
            {formatCount(stats.chars)} characters · {formatCount(stats.words)} words
            {stats.chars > 0 && ` · about ${formatDurationWords(stats.seconds)}`}
            {stats.chunks > 0 && ` · ${stats.chunks} ${stats.chunks === 1 ? 'chunk' : 'chunks'}`}
          </Text>
          <Button
            variant="gradient"
            size="md"
            radius="xl"
            leftSection={<IconPlayerPlayFilled size={18} />}
            onClick={() => startPlayback()}
            disabled={!text.trim() || overLimit}
            data-testid="read-aloud"
          >
            Read aloud
          </Button>
        </Group>
        {overLimit && limits && (
          <Text size="xs" c="red">
            This server reads up to {formatCount(limits.max_text_chars)} characters at a time.
          </Text>
        )}
        {tooLarge && (
          <Text size="xs" c="yellow.7">
            This text is too large to keep as a draft; it will not survive a reload.
          </Text>
        )}
      </Stack>
    </motion.section>
  );
}
