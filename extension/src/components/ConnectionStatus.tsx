import { Alert, Badge, Group, Loader, Stack, Text } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconKey,
  IconPlugConnectedX,
} from '@tabler/icons-react';
import { motion } from 'motion/react';
import type { ConnectionTestResult } from '@tamber/client';
import { describeError } from '../lib/client';

export type ConnectionView =
  | { kind: 'idle' }
  | { kind: 'testing' }
  | { kind: 'no-permission'; origin: string }
  | { kind: 'result'; result: ConnectionTestResult };

/** Status of the configured server: reachable, auth, version (options page and popup). */
export function ConnectionStatus({
  view,
  compact = false,
}: {
  view: ConnectionView;
  compact?: boolean;
}) {
  if (view.kind === 'idle') return null;
  if (view.kind === 'testing') {
    return (
      <Group gap="xs">
        <Loader size="xs" />
        <Text size="sm" c="dimmed">
          Testing connection…
        </Text>
      </Group>
    );
  }
  if (view.kind === 'no-permission') {
    return (
      <Alert color="yellow" icon={<IconKey size={18} />} title="Access not granted" radius="lg">
        Chrome needs your permission to talk to <b>{view.origin}</b>. Click Save (or Test
        connection) and accept the prompt.
      </Alert>
    );
  }
  const { result } = view;
  const h = result.health;
  let content;
  if (result.ok && h) {
    content = (
      <Alert
        color="teal"
        icon={<IconCircleCheck size={18} />}
        title={compact ? 'Connected' : `Connected to Tamber ${h.version}`}
        radius="lg"
      >
        {!compact && (
          <Stack gap={4}>
            <Group gap={6}>
              <Badge variant="light" color={h.status === 'ok' ? 'teal' : 'yellow'}>
                {h.status === 'ok' ? 'ready' : h.status}
              </Badge>
              <Badge variant="light">{h.engine}</Badge>
              <Badge variant="light">{h.device}</Badge>
              <Badge variant="light" color={h.auth_required ? 'tamber' : 'gray'}>
                {h.auth_required ? 'API key accepted' : 'no API key needed'}
              </Badge>
              {result.voiceCount !== null && (
                <Badge variant="light" color="gray">
                  {result.voiceCount} voices
                </Badge>
              )}
            </Group>
            {result.compatible === false && (
              <Text size="sm" c="yellow">
                This server speaks API version {h.api_version}; the extension expects version 1.
              </Text>
            )}
          </Stack>
        )}
      </Alert>
    );
  } else if (h && result.authOk === false) {
    content = (
      <Alert
        color="red"
        icon={<IconKey size={18} />}
        title="API key required or rejected"
        radius="lg"
      >
        The server is reachable (Tamber {h.version}) but did not accept the API key.
      </Alert>
    );
  } else if (h) {
    content = (
      <Alert
        color="yellow"
        icon={<IconAlertTriangle size={18} />}
        title="Server reachable"
        radius="lg"
      >
        {result.error ? describeError(result.error) : 'The voice list could not be loaded.'}
      </Alert>
    );
  } else {
    content = (
      <Alert color="red" icon={<IconPlugConnectedX size={18} />} title="Unreachable" radius="lg">
        {result.error ? describeError(result.error) : 'The server did not answer.'}
      </Alert>
    );
  }
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      {content}
    </motion.div>
  );
}
