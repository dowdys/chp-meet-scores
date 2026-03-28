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

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina",
  ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "Washington D.C.",
};

function stateName(abbrev: string): string {
  return STATE_NAMES[abbrev] || abbrev;
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

  // No debounce needed — these filter local arrays, not network requests

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
  // Note: meets stores abbreviations ("MN"), winners stores full names ("Minnesota")
  useEffect(() => {
    if (!selection.state) {
      setGyms([]);
      return;
    }
    const fullName = stateName(selection.state);
    supabase
      .from("winners")
      .select("gym")
      .eq("state", fullName)
      .limit(5000) // Prevent silent 1000-row truncation
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
    const fullName = stateName(selection.state);
    supabase
      .from("winners")
      .select("name, meet_name, level")
      .eq("state", fullName)
      .eq("gym", selection.gym)
      .limit(5000) // Prevent silent 1000-row truncation
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
  const filteredStates = stateQuery
    ? states.filter((s) => {
        const q = stateQuery.toLowerCase();
        return s.toLowerCase().includes(q) || stateName(s).toLowerCase().includes(q);
      })
    : states;

  const filteredGyms = gymQuery
    ? gyms.filter((g) =>
        g.toLowerCase().includes(gymQuery.toLowerCase())
      )
    : gyms;

  const filteredAthletes = athleteQuery
    ? athletes.filter((a) =>
        a.name.toLowerCase().includes(athleteQuery.toLowerCase())
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
          className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-gray-900"
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
          className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-gray-900"
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
          immediate
        >
          <ComboboxInput
            className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-gray-900"
            placeholder="Select or search state..."
            displayValue={(val: string) => stateName(val)}
            onChange={(e) => setStateQuery(e.target.value)}
            disabled={!selection.league}
          />
          <ComboboxOptions
            anchor="bottom"
            className="w-[var(--input-width)] rounded-lg border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto z-50"
          >
            {filteredStates.length === 0 && (
              <div className="px-3 py-2 text-gray-400 text-sm">No states found</div>
            )}
            {filteredStates.map((s) => (
              <ComboboxOption
                key={s}
                value={s}
                className="px-3 py-2 cursor-pointer data-[focus]:bg-red-50[focus]:bg-red-900/20 text-black"
              >
                {stateName(s)}
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
          immediate
        >
          <ComboboxInput
            className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-gray-900"
            placeholder="Select or search gym..."
            displayValue={(val: string) => val}
            onChange={(e) => setGymQuery(e.target.value)}
            disabled={!selection.state}
          />
          <ComboboxOptions
            anchor="bottom"
            className="w-[var(--input-width)] rounded-lg border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto z-50"
          >
            {filteredGyms.length === 0 && (
              <div className="px-3 py-2 text-gray-400 text-sm">No gyms found</div>
            )}
            {filteredGyms.map((g) => (
              <ComboboxOption
                key={g}
                value={g}
                className="px-3 py-2 cursor-pointer data-[focus]:bg-red-50[focus]:bg-red-900/20 text-black"
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
          immediate
        >
          <ComboboxInput
            className="w-full rounded-lg border border-gray-300 px-3 py-2 bg-white text-gray-900"
            placeholder="Select or search athlete..."
            displayValue={(val: { name: string } | null) => val?.name || ""}
            onChange={(e) => setAthleteQuery(e.target.value)}
            disabled={!selection.gym}
          />
          <ComboboxOptions
            anchor="bottom"
            className="w-[var(--input-width)] rounded-lg border border-gray-200 bg-white shadow-lg max-h-60 overflow-auto z-50"
          >
            {filteredAthletes.length === 0 && (
              <div className="px-3 py-2 text-gray-400 text-sm">No athletes found</div>
            )}
            {filteredAthletes.map((a) => (
              <ComboboxOption
                key={`${a.name}-${a.meet_name}`}
                value={a}
                className="px-3 py-2 cursor-pointer data-[focus]:bg-red-50[focus]:bg-red-900/20 text-black"
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
