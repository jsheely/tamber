import { ActionIcon, Button, Group, Text } from '@mantine/core';
import { IconRefresh, IconX } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { useAppUpdate } from '../lib/appUpdate';
import classes from './UpdateBanner.module.css';

/** "A new version is ready" bar under the header; the installed app has no reload button. */
export function UpdateBanner() {
  const needRefresh = useAppUpdate((s) => s.needRefresh);
  const dismissed = useAppUpdate((s) => s.dismissed);
  const applying = useAppUpdate((s) => s.applying);
  const apply = useAppUpdate((s) => s.apply);
  const dismiss = useAppUpdate((s) => s.dismiss);
  const show = needRefresh && !dismissed;
  return (
    <AnimatePresence initial={false}>
      {show && (
        <motion.div
          className={classes.banner}
          role="status"
          data-testid="update-banner"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.2 }}
        >
          <Group gap="sm" wrap="nowrap" className={classes.inner}>
            <Text size="sm" fw={600} style={{ flex: 1 }}>
              A new version of Tamber is ready.
            </Text>
            <Button
              size="xs"
              radius="xl"
              variant="white"
              color="dark"
              leftSection={<IconRefresh size={14} />}
              loading={applying}
              onClick={() => void apply()}
              data-testid="update-apply"
            >
              Update
            </Button>
            <ActionIcon
              size={32}
              radius="xl"
              variant="subtle"
              color="gray"
              aria-label="Dismiss update notice"
              onClick={dismiss}
            >
              <IconX size={16} />
            </ActionIcon>
          </Group>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
