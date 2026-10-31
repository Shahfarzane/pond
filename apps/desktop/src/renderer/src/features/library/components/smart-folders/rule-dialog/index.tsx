import type { Query } from "@pond/schema/filters/types";
import { Button, Dialog, Field, Input } from "@pond/ui";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { combineQueries } from "@/features/library/lib/smart-folders";
import { errorCopy } from "@/shared/lib/error-copy";
import { formatPlural } from "@/shared/lib/format";
import {
  compileRuleQuery,
  editableQuery,
  type RuleChoices,
  RuleEditor,
  ruleQueryReady,
} from "../rule-editor";
import styles from "./styles.module.css";

export interface RuleDialogProps {
  kind: "smart_folder" | "group";
  name?: string;
  query: Query;
  inheritedQuery: Query;
  parentName?: string;
  editing?: boolean;
  libraryRevision?: number;
  choices: RuleChoices;
  count: (query: Query) => Promise<number>;
  onSave: (name: string, query: Query) => Promise<void>;
  onClose: () => void;
}

type PreviewState = {
  key: string;
  revision: number;
  status: "loading" | "ready" | "failed";
  count: number | null;
};

export function RuleDialog(props: RuleDialogProps) {
  const {
    kind,
    inheritedQuery,
    parentName,
    choices,
    count,
    onSave,
    onClose,
    editing,
    libraryRevision = 0,
  } = props;
  const [name, setName] = useState(props.name ?? "");
  const [query, setQuery] = useState(() => editableQuery(props.query));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    setOpen(true);
  }, []);
  const label = kind === "group" ? "Group" : "Smart Folder";
  const ready = ruleQueryReady(query);
  const effectiveQuery = useMemo(
    () =>
      ready ? combineQueries([inheritedQuery, compileRuleQuery(query)]) : query,
    [inheritedQuery, query, ready],
  );
  const queryKey = JSON.stringify(effectiveQuery);
  const queryRef = useRef(effectiveQuery);
  queryRef.current = effectiveQuery;
  const [preview, setPreview] = useState<PreviewState>({
    key: queryKey,
    revision: libraryRevision,
    status: "loading",
    count: null,
  });

  useEffect(() => {
    if (!ready) return;
    let current = true;
    const key = queryKey;
    const timer = window.setTimeout(() => {
      const request = queryRef.current;
      setPreview((currentPreview) =>
        currentPreview.key === key
          ? currentPreview
          : {
              key,
              revision: libraryRevision,
              status: "loading",
              count: null,
            },
      );
      void count(request).then(
        (total) => {
          if (current)
            setPreview({
              key,
              revision: libraryRevision,
              status: "ready",
              count: total,
            });
        },
        () => {
          if (!current) return;
          setPreview((currentPreview) =>
            currentPreview.key === key && currentPreview.count != null
              ? { ...currentPreview, revision: libraryRevision }
              : {
                  key,
                  revision: libraryRevision,
                  status: "failed",
                  count: null,
                },
          );
        },
      );
    }, 200);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [queryKey, ready, count, libraryRevision]);

  const countText = !ready
    ? "Complete the rules to preview matches."
    : preview.key === queryKey && preview.count != null
      ? `Found ${formatPlural(preview.count, { one: "save", other: "saves" })}`
      : preview.key === queryKey && preview.status === "failed"
        ? "Couldn't count matches. Your rules can still be saved."
        : "Counting matches";

  const submit = async () => {
    if (!ready || !name.trim() || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onSave(name.trim(), compileRuleQuery(query));
      setOpen(false);
    } catch (failure) {
      setError(errorCopy(failure, "Couldn't save these rules. Try again."));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next, details) => {
        if (pending.current) details.cancel();
        else setOpen(next);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup className={styles.popup}>
          <form
            className={styles.form}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            aria-busy={busy}
          >
            <Dialog.Header>
              <Dialog.Title>
                {editing ? "Edit" : "New"} {label}
              </Dialog.Title>
            </Dialog.Header>
            <div className={styles.body}>
              <Field.Root className={styles.name}>
                <Field.Label>{label} Name</Field.Label>
                <Input.Root size="sm">
                  <Field.Control
                    render={<Input.Field autoFocus />}
                    value={name}
                    onValueChange={setName}
                    disabled={busy}
                  />
                </Input.Root>
              </Field.Root>
              <Dialog.Description className={styles.description}>
                {kind === "group"
                  ? "These rules filter every smart folder and saved view in this group."
                  : "This smart folder automatically collects saves that match these rules."}
              </Dialog.Description>
              {parentName ? (
                <p className={styles.inherited}>
                  Also matches the rules in {parentName}.
                </p>
              ) : null}
              <fieldset className={styles.editor} disabled={busy}>
                <legend className={styles.hidden}>Matching Rules</legend>
                <RuleEditor
                  query={query}
                  choices={choices}
                  onChange={setQuery}
                />
              </fieldset>
              {error ? (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              ) : null}
            </div>
            <Dialog.Footer
              leading={
                <p className={styles.count} role="status" aria-live="polite">
                  {countText}
                </p>
              }
            >
              <Dialog.Cancel disabled={busy} />
              <Button
                type="submit"
                variant="primary"
                disabled={busy || !ready || !name.trim()}
                loading={busy}
              >
                {busy ? "Saving" : editing ? "Save" : "Create"}
              </Button>
            </Dialog.Footer>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
