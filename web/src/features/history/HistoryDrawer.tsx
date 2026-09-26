import { ActionIcon, Button, Group, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { formatCount } from '../../lib/format';
import { useDraft } from '../../store/draft';
import { useHistory } from '../../store/history';
import { useSession } from '../../store/session';
import { ResponsiveDrawer } from '../../ui/ResponsiveDrawer';

function relativeTime(ts: number): string {
  const diff = Math.round((Date.now() - ts) / 1000);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (diff < 60) return rtf.format(-diff, 'second');
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

/** Recently read texts (persisted, capped). Tap to load one back into the composer. */
export default function HistoryDrawer() {
  const opened = useSession((s) => s.drawer === 'history');
  const close = useSession((s) => s.closeDrawer);
  const setView = useSession((s) => s.setView);
  const entries = useHistory((s) => s.entries);
  const remove = useHistory((s) => s.remove);
  const clear = useHistory((s) => s.clear);
  const setText = useDraft((s) => s.setText);
  const [confirm, setConfirm] = useState(false);

  return (
    <ResponsiveDrawer opened={opened} onClose={close} title="Recent texts">
      <Stack gap="xs">
        {entries.length === 0 && (
          <Text c="dimmed" ta="center" py="xl">
            Texts you play will show up here.
          </Text>
        )}
        <AnimatePresence initial={false}>
          {entries.map((e) => (
            <motion.div
              key={e.id}
              layout="position"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, x: -24 }}
              transition={{ duration: 0.18 }}
            >
              <Group
                wrap="nowrap"
                gap={4}
                className="tamber-surface"
                style={{ borderRadius: 'var(--mantine-radius-lg)', padding: '4px 4px 4px 14px' }}
              >
                <UnstyledButton
                  style={{ flex: 1, minWidth: 0, minHeight: 56, padding: '6px 0' }}
                  onClick={() => {
                    setText(e.text);
                    setView('compose');
                    close();
                  }}
                  aria-label={`Load "${e.title}"`}
                >
                  <Text fw={600} truncate>
                    {e.title}
                  </Text>
                  <Text size="xs" c="dimmed" truncate>
                    {relativeTime(e.createdAt)} · {formatCount(e.chars)} characters
                    {e.voice ? ` · ${e.voice}` : ''}
                  </Text>
                </UnstyledButton>
                <ActionIcon
                  size={44}
                  radius="xl"
                  color="gray"
                  variant="subtle"
                  aria-label={`Remove "${e.title}"`}
                  onClick={() => remove(e.id)}
                >
                  <IconTrash size={18} />
                </ActionIcon>
              </Group>
            </motion.div>
          ))}
        </AnimatePresence>
        {entries.length > 0 && (
          <Button
            variant={confirm ? 'filled' : 'subtle'}
            color="red"
            mt="sm"
            onClick={() => {
              if (!confirm) {
                setConfirm(true);
                return;
              }
              clear();
              setConfirm(false);
            }}
            onBlur={() => setConfirm(false)}
          >
            {confirm ? 'Tap again to clear all' : 'Clear history'}
          </Button>
        )}
      </Stack>
    </ResponsiveDrawer>
  );
}
