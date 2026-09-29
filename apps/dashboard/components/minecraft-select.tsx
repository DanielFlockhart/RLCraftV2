"use client";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Check, ChevronDown } from "lucide-react";
import { MinecraftIcon, type MinecraftAsset } from "./minecraft-icon";

export interface MinecraftOption {
  value: string;
  label: string;
  icon: MinecraftAsset;
  description?: string;
}
export function MinecraftSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = "Select an option",
}: {
  label: string;
  value: string;
  options: MinecraftOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = options.find((option) => option.value === value);
  const search = useRef({ value: "", at: 0 });
  useEffect(() => {
    setCursor((index) => Math.max(0, Math.min(index, options.length - 1)));
  }, [options.length]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    if (open)
      document
        .getElementById(`${id}-option-${cursor}`)
        ?.scrollIntoView({ block: "nearest" });
  }, [cursor, open, id]);
  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    setOpen(false);
    trigger.current?.focus();
  };
  function keys(event: KeyboardEvent<HTMLButtonElement>) {
    const start = Math.max(
      0,
      options.findIndex((option) => option.value === value),
    );
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setOpen(true);
      setCursor(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : !open
              ? start
              : Math.max(
                  0,
                  Math.min(
                    options.length - 1,
                    cursor + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
      );
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(cursor);
      else {
        setCursor(start);
        setOpen(true);
      }
      return;
    }
    if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const now = Date.now();
      search.current = {
        value:
          (now - search.current.at > 700 ? "" : search.current.value) +
          event.key.toLowerCase(),
        at: now,
      };
      const match = options.findIndex((option) =>
        option.label.toLowerCase().startsWith(search.current.value),
      );
      if (match >= 0) {
        event.preventDefault();
        setCursor(match);
        setOpen(true);
      }
    }
  }
  return (
    <div
      className="minecraft-select"
      ref={root}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      <label htmlFor={id}>{label}</label>
      <button
        ref={trigger}
        type="button"
        id={id}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-activedescendant={
          open && options[cursor] ? `${id}-option-${cursor}` : undefined
        }
        disabled={disabled || options.length === 0}
        className="minecraft-select-trigger"
        onKeyDown={keys}
        onClick={() => {
          setCursor(
            Math.max(
              0,
              options.findIndex((option) => option.value === value),
            ),
          );
          setOpen(!open);
        }}
      >
        {selected && <MinecraftIcon name={selected.icon} size={26} />}
        <span>{selected?.label ?? placeholder}</span>
        <ChevronDown size={15} />
      </button>
      {open && (
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={label}
          className="minecraft-select-menu"
        >
          {options.map((option, index) => (
            <div
              key={option.value}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={option.value === value}
              className={`minecraft-select-option ${cursor === index ? "highlighted" : ""}`}
              onPointerMove={() => setCursor(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(index)}
            >
              <MinecraftIcon name={option.icon} size={30} />
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
              {option.value === value && <Check size={15} />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
