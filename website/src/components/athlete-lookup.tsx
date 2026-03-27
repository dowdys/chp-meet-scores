"use client";

import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";

interface LookupState {
  year: string;
  league: string;
  state: string;
  gym: string;
  athlete: { name: string; meet_name: string } | null;
}

interface AthleteLookupProps {
  onAthleteSelected: (athlete: {
    name: string;
    gym: string;
    meet_name: string;
    state: string;
    level: string;
  }) => void;
  onNoResults?: () => void;
}

const currentYear = new Date().getFullYear().toString();

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debouncedValue;
}

export function AthleteLookup({
  onAthleteSelected,
  onNoResults,
}: AthleteLookupProps) {
  const [supabase] = useState(() => createClient());

  const [selection, setSelection] = useState<LookupState>({
    year: currentYear,
    league: "",
    state: "",
    gym: "",
    athlete: null,
  });

  // Available options for each dropdown
  const [years, setYears] = useState<string[]>([currentYear]);
  const [leagues, setLeagues] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [gyms, setGyms] = useState<string[]>([]);
  const [athletes, setAthletes] = useState<
    { name: string; meet_name: string; level: string }[]
  >([]);

  // Search queries for each combobox
  const [stateQuery, setStateQuery] = useState("");
  const [gymQuery, setGymQuery] = useState("");
  const [athleteQuery, setAthleteQuery] = useState("");

  const debouncedStateQuery = useDebounce(stateQuery, 200);
  const debouncedGymQuery = useDebounce(gymQuery, 200);
  const debouncedAthleteQuery = useDebounce(athleteQuery, 200);

  // Load available years
  useEffect(() => {
    supabase
      .from("meets")
      .select("year")
      .then(({ data }) => {
        if (data) {
          const unique = [...new Set(data.map((m) => m.year))].sort().reverse();
          setYears(unique.length > 0 ? unique : [currentYear]);
        }
      });
  }, [supabase]);

  // Load leagues when year changes
  useEffect(() => {
    if (!selection.year) return;
    supabase
      .from("meets")
      .select("association")
      .eq("year", selection.year)
      .not("association", "is", null)
      .then(({ data }) => {
        if (data) {
          const unique = [...new Set(data.map((m) => m.association))].filter(
            Boolean
          ) as string[];
          setLeagues(unique.sort());
        }
      });
  }, [supabase, selection.year]);

  // Load states when year + league selected
  useEffect(() => {
    if (!selection.year || !selection.league) {
      setStates([]);
      return;
    }
    supabase
      .from("meets")
      .select("state")
      .eq("year", selection.year)
      .eq("association", selection.league)
      .then(({ data }) => {
        if (data) {
          const unique = [...new Set(data.map((m) => m.state))].filter(
            Boolean
          ) as string[];
          setStates(unique.sort());
        }
      });
  }, [supabase, selection.year, selection.league]);

  // Load gyms when state selected
  useEffect(() => {
    if (!selection.state) {
      setGyms([]);
      return;
    }
    supabase
      .from("winners")
      .select("gym")
      .eq("state", selection.state)
      .then(({ data }) => {
        if (data) {
          const unique = [...new Set(data.map((w) => w.gym))].filter(
            Boolean
          ) as string[];
          setGyms(unique.sort());
        }
      });
  }, [supabase, selection.state]);

  // Load athletes when gym selected
  useEffect(() => {
    if (!selection.gym || !selection.state) {
      setAthletes([]);
      return;
    }
    supabase
      .from("winners")
      .select("name, meet_name, level")
      .eq("state", selection.state)
      .eq("gym", selection.gym)
      .then(({ data }) => {
        if (data) {
          // Deduplicate by name + meet_name
          const seen = new Set<string>();
          const unique = data.filter((w) => {
            const key = `${w.name}|${w.meet_name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          setAthletes(unique.sort((a, b) => a.name.localeCompare(b.name)));
          if (unique.length === 0 && onNoResults) {
            onNoResults();
          }
        }
      });
  }, [supabase, selection.state, selection.gym, onNoResults]);

  const handleAthleteSelect = useCallback(
    (athlete: { name: string; meet_name: string; level: string } | null) => {
      if (!athlete) return;
      setSelection((prev) => ({
        ...prev,
        athlete: { name: athlete.name, meet_name: athlete.meet_name },
      }));
      onAthleteSelected({
        name: athlete.name,
        gym: selection.gym,
        meet_name: athlete.meet_name,
        state: selection.state,
        level: athlete.level,
      });
    },
    [onAthleteSelected, selection.gym, selection.state]
  );

  // Filter options based on search query
  const filteredStates = debouncedStateQuery
    ? states.filter((s) =>
        s.toLowerCase().includes(debouncedStateQuery.toLowerCase())
      )
    : states;

  const filteredGyms = debouncedGymQuery
    ? gyms.filter((g) =>
        g.toLowerCase().includes(debouncedGymQuery.toLowerCase())
      )
    : gyms;

  const filteredAthletes = debouncedAthleteQuery
    ? athletes.filter((a) =>
        a.name.toLowerCase().includes(debouncedAthleteQuery.toLowerCase())
      )
    : athletes;

  return (
    <div className="space-y-4 w-full max-w-md">
      {/* Year */}
      <div>
        <label className="block text-sm font-medium mb-1">Year</label>
        <select
          value={selection.year}
          onChange={(e) =>
            setSelection({
              year: e.target.value,
              league: "",
              state: "",
              gym: "",
              athlete: null,
            })
          }
          className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-black"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>

      {/* League */}
      <div>
        <label className="block text-sm font-medium mb-1">League</label>
        <select
          value={selection.league}
          onChange={(e) =>
            setSelection((prev) => ({
              ...prev,
              league: e.target.value,
              state: "",
              gym: "",
              athlete: null,
            }))
          }
          className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-black"
          disabled={leagues.length === 0}
        >
          <option value="">Select league...</option>
          {leagues.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </div>

      {/* State (searchable combobox) */}
      <div>
        <label className="block text-sm font-medium mb-1">State</label>
        <Combobox
          value={selection.state}
          onChange={(val) =>
            setSelection((prev) => ({
              ...prev,
              state: val || "",
              gym: "",
              athlete: null,
            }))
          }
          onClose={() => setStateQuery("")}
        >
          <ComboboxInput
            className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-black"
            placeholder="Type to search states..."
            displayValue={(val: string) => val}
            onChange={(e) => setStateQuery(e.target.value)}
            disabled={!selection.league}
          />
          <ComboboxOptions
            anchor="bottom"
            className="w-[var(--input-width)] rounded-lg border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto empty:invisible"
          >
            {filteredStates.map((s) => (
              <ComboboxOption
                key={s}
                value={s}
                className="px-3 py-2 cursor-pointer data-[focus]:bg-yellow-50 text-black"
              >
                {s}
              </ComboboxOption>
            ))}
          </ComboboxOptions>
        </Combobox>
      </div>

      {/* Gym (searchable combobox) */}
      <div>
        <label className="block text-sm font-medium mb-1">Gym</label>
        <Combobox
          value={selection.gym}
          onChange={(val) =>
            setSelection((prev) => ({
              ...prev,
              gym: val || "",
              athlete: null,
            }))
          }
          onClose={() => setGymQuery("")}
        >
          <ComboboxInput
            className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-black"
            placeholder="Type to search gyms..."
            displayValue={(val: string) => val}
            onChange={(e) => setGymQuery(e.target.value)}
            disabled={!selection.state}
          />
          <ComboboxOptions
            anchor="bottom"
            className="w-[var(--input-width)] rounded-lg border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto empty:invisible"
          >
            {filteredGyms.map((g) => (
              <ComboboxOption
                key={g}
                value={g}
                className="px-3 py-2 cursor-pointer data-[focus]:bg-yellow-50 text-black"
              >
                {g}
              </ComboboxOption>
            ))}
          </ComboboxOptions>
        </Combobox>
      </div>

      {/* Athlete Name (searchable combobox) */}
      <div>
        <label className="block text-sm font-medium mb-1">Athlete Name</label>
        <Combobox
          value={selection.athlete as { name: string; meet_name: string; level: string } | null}
          onChange={handleAthleteSelect}
          onClose={() => setAthleteQuery("")}
        >
          <ComboboxInput
            className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-black"
            placeholder="Type to search athletes..."
            displayValue={(val: { name: string } | null) => val?.name || ""}
            onChange={(e) => setAthleteQuery(e.target.value)}
            disabled={!selection.gym}
          />
          <ComboboxOptions
            anchor="bottom"
            className="w-[var(--input-width)] rounded-lg border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto empty:invisible"
          >
            {filteredAthletes.map((a) => (
              <ComboboxOption
                key={`${a.name}-${a.meet_name}`}
                value={a}
                className="px-3 py-2 cursor-pointer data-[focus]:bg-yellow-50 text-black"
              >
                <span className="font-medium">{a.name}</span>
                <span className="ml-2 text-sm text-gray-500">
                  Level {a.level}
                </span>
              </ComboboxOption>
            ))}
          </ComboboxOptions>
        </Combobox>
      </div>
    </div>
  );
}
