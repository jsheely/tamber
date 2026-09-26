/**
 * Options page (full tab): server + API key with the runtime permission request and connection
 * test, voice library, playback, reading, appearance, extension-only settings, shortcuts, reset.
 */
import { useState } from 'react';
import { Alert, Box, Container, Group, Stack, Text, Title } from '@mantine/core';
import { IconKey, IconSparkles } from '@tabler/icons-react';
import { motion } from 'motion/react';
import { Brand } from '../../components/Brand';
import { Orb } from '../../components/Orb';
import { SettingsForm } from '../../components/SettingsForm';

type Reason = 'setup' | 'permission' | null;

function readReason(): Reason {
  const h = window.location.hash.replace('#', '');
  return h === 'setup' || h === 'permission' ? h : null;
}

export function App() {
  const [reason] = useState<Reason>(readReason);
  return (
    <Box
      mih="100vh"
      style={{
        background:
          'radial-gradient(1200px 400px at 10% -10%, color-mix(in srgb, var(--tamber-violet) 14%, transparent), transparent), radial-gradient(900px 400px at 110% 0%, color-mix(in srgb, var(--tamber-cyan) 10%, transparent), transparent)',
      }}
    >
      <Container size="md" py="xl">
        <Stack gap="lg">
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Group justify="space-between" align="center">
              <Stack gap={4}>
                <Brand size={34} />
                <Text c="dimmed" size="sm">
                  Read any text aloud with your self-hosted Tamber voice server.
                </Text>
              </Stack>
              <Orb status="idle" size={48} />
            </Group>
          </motion.div>
          {reason === 'setup' && (
            <Alert color="tamber" radius="lg" icon={<IconSparkles size={18} />}>
              <Title order={4} fz="md">
                Welcome to Tamber
              </Title>
              <Text size="sm">
                Enter your server address below and click <b>Save</b>. Chrome will ask to allow
                access to that one site; nothing else is requested.
              </Text>
            </Alert>
          )}
          {reason === 'permission' && (
            <Alert color="yellow" radius="lg" icon={<IconKey size={18} />}>
              Tamber needs permission to reach your server. Click <b>Save</b> and accept Chrome's
              prompt.
            </Alert>
          )}
          <SettingsForm focusServer={reason !== null} />
        </Stack>
      </Container>
    </Box>
  );
}
