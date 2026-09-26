import { Button, Stack, Text } from '@mantine/core';
import { IconVolume } from '@tabler/icons-react';
import { AnimatePresence, motion } from 'motion/react';
import { resumeFromGesture } from '../player/actions';
import { usePlayerState } from '../player/usePlayer';

/**
 * iOS suspends/interrupts the AudioContext (lock, call, backgrounding). Audio can only come back
 * from a user gesture, so we ask for one instead of retrying resume() in the background.
 */
export function TapToResume() {
  const needsGesture = usePlayerState((s) => s.needsGesture);
  return (
    <AnimatePresence>
      {needsGesture && (
        <motion.div
          key="tap-to-resume"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 300,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(15, 13, 28, 0.55)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          }}
          onClick={resumeFromGesture}
          role="dialog"
          aria-modal="true"
          aria-label="Audio paused by the system"
        >
          <motion.div initial={{ scale: 0.9, y: 12 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.9 }}>
            <Stack align="center" gap="md" p="xl">
              <Button
                size="xl"
                radius="xl"
                variant="gradient"
                leftSection={<IconVolume size={26} />}
                onClick={(e) => {
                  e.stopPropagation();
                  resumeFromGesture();
                }}
                data-autofocus
              >
                Tap to resume audio
              </Button>
              <Text c="gray.3" size="sm" ta="center" maw={300}>
                Your device paused audio (screen lock, a call or another app). Tap to continue where you
                left off.
              </Text>
            </Stack>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
