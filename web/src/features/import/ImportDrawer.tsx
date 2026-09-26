import { Button, Divider, Group, Stack, Text, TextInput } from '@mantine/core';
import { Dropzone, type FileRejection } from '@mantine/dropzone';
import { notifications } from '@mantine/notifications';
import type { ExtractResponse } from '@tamber/client';
import { IconFileText, IconLink, IconUpload, IconX } from '@tabler/icons-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { notifyError } from '../../api/errors';
import { getClient } from '../../api/useTamberClient';
import { formatBytes, formatCount } from '../../lib/format';
import { useDraft } from '../../store/draft';
import { useSession } from '../../store/session';
import { ResponsiveDrawer } from '../../ui/ResponsiveDrawer';
import { composeImportedText, IMPORT_ACCEPT, importInfoFrom, normalizeImportUrl } from './importText';

/** Import from a URL or a document (PDF, DOCX, EPUB, TXT, HTML, Markdown) via /v1/extract. */
export default function ImportDrawer() {
  const opened = useSession((s) => s.drawer === 'import');
  const close = useSession((s) => s.closeDrawer);
  const setView = useSession((s) => s.setView);
  const features = useSession((s) => s.health?.features);
  const maxBytes = useSession((s) => s.health?.limits.max_upload_bytes ?? 25 * 1024 * 1024);
  const setImported = useDraft((s) => s.setImported);

  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'url' | 'file' | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!opened) ctrlRef.current?.abort();
  }, [opened]);
  useEffect(() => () => ctrlRef.current?.abort(), []);

  const finish = (res: ExtractResponse) => {
    setImported(composeImportedText(res), importInfoFrom(res));
    setView('compose');
    close();
    notifications.show({
      color: res.truncated ? 'yellow' : 'tamber',
      title: res.title ? `Imported "${res.title}"` : 'Imported',
      message: `${formatCount(res.word_count)} words${res.truncated ? ' (truncated at the server limit)' : ''}`,
    });
  };

  const run = async (kind: 'url' | 'file', fn: (signal: AbortSignal) => Promise<ExtractResponse>, retry: () => void) => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setBusy(kind);
    try {
      finish(await fn(ctrl.signal));
    } catch (err) {
      if (!ctrl.signal.aborted) notifyError(err, { retry, id: 'tamber-import' });
    } finally {
      if (ctrlRef.current === ctrl) {
        ctrlRef.current = null;
        setBusy(null);
      }
    }
  };

  const importUrl = (target: string) =>
    void run('url', (signal) => getClient().extractUrl(target, { signal }), () => importUrl(target));

  const importFile = (file: File) =>
    void run(
      'file',
      (signal) => getClient().extractFile({ file, filename: file.name, contentType: file.type }, { signal }),
      () => importFile(file),
    );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const normalized = normalizeImportUrl(url);
    if (!normalized) {
      setUrlError('Enter a web address, like https://example.com/article');
      return;
    }
    setUrlError(null);
    importUrl(normalized);
  };

  const onReject = (rejections: FileRejection[]) => {
    const first = rejections[0];
    const tooBig = first?.errors.some((e) => e.code === 'file-too-large');
    notifications.show({
      color: 'red',
      title: tooBig ? 'File is too large' : 'Unsupported file',
      message: tooBig
        ? `The server accepts files up to ${formatBytes(maxBytes)}.`
        : 'Use a PDF, DOCX, EPUB, TXT, HTML or Markdown file.',
    });
  };

  return (
    <ResponsiveDrawer opened={opened} onClose={close} title="Import text">
      <Stack gap="lg">
        {features?.extract_url !== false && (
          <form onSubmit={onSubmit} noValidate>
            <Stack gap="xs">
              <Text fw={600}>From a web page</Text>
              <Group gap="xs" align="flex-start" wrap="nowrap">
                <TextInput
                  style={{ flex: 1 }}
                  type="text"
                  inputMode="url"
                  autoCapitalize="off"
                  autoCorrect="off"
                  placeholder="https://example.com/article"
                  aria-label="Web page address"
                  leftSection={<IconLink size={16} />}
                  value={url}
                  onChange={(e) => setUrl(e.currentTarget.value)}
                  error={urlError}
                  size="md"
                />
                <Button type="submit" size="md" loading={busy === 'url'} disabled={busy === 'file'}>
                  Import
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                The server downloads the page and keeps only the article text.
              </Text>
            </Stack>
          </form>
        )}
        <Divider label="or" labelPosition="center" />
        {features?.extract_file !== false && (
          <Stack gap="xs">
            <Text fw={600}>From a document</Text>
            <Dropzone
              onDrop={(files) => files[0] && importFile(files[0])}
              onReject={onReject}
              maxSize={maxBytes}
              maxFiles={1}
              multiple={false}
              accept={IMPORT_ACCEPT}
              loading={busy === 'file'}
              disabled={busy === 'url'}
              radius="lg"
              aria-label="Choose or drop a document"
            >
              <Stack align="center" gap={6} py="lg" style={{ pointerEvents: 'none' }}>
                <Dropzone.Accept>
                  <IconUpload size={40} color="var(--mantine-color-tamber-5)" />
                </Dropzone.Accept>
                <Dropzone.Reject>
                  <IconX size={40} color="var(--mantine-color-red-6)" />
                </Dropzone.Reject>
                <Dropzone.Idle>
                  <IconFileText size={40} opacity={0.7} />
                </Dropzone.Idle>
                <Text fw={600} ta="center">
                  Tap to choose a file, or drop it here
                </Text>
                <Text size="xs" c="dimmed" ta="center">
                  PDF, DOCX, EPUB, TXT, HTML or Markdown, up to {formatBytes(maxBytes)}
                </Text>
              </Stack>
            </Dropzone>
          </Stack>
        )}
      </Stack>
    </ResponsiveDrawer>
  );
}
