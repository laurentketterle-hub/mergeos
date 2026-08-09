package core

import (
	"strings"
	"testing"
)

func TestAdminBountyTypeRewardMRGMapping(t *testing.T) {
	tests := []struct {
		bountyType string
		expected   int64
	}{
		{"future-small", 25},
		{"future-medium", 50},
		{"bug-large", 100},
		{"major-feature", 200},
	}
	for _, tt := range tests {
		got, ok := adminBountyTypeRewardMRG[tt.bountyType]
		if !ok {
			t.Errorf("bounty type %q not found in mapping", tt.bountyType)
			continue
		}
		if got != tt.expected {
			t.Errorf("adminBountyTypeRewardMRG[%q] = %d, want %d", tt.bountyType, got, tt.expected)
		}
	}
}

func TestSelectedManualCreditRewardMRG(t *testing.T) {
	tests := []struct {
		name string
		req  AdminManualCreditRequest
		want int64
	}{
		{"reward_mrg takes priority", AdminManualCreditRequest{RewardMRG: 100, AmountMRG: 50, RewardCents: 200}, 100},
		{"amount_mrg fallback", AdminManualCreditRequest{AmountMRG: 50, RewardCents: 200}, 50},
		{"reward_cents fallback", AdminManualCreditRequest{RewardCents: 200}, 200},
		{"zero when all zero", AdminManualCreditRequest{}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := selectedManualCreditRewardMRG(tt.req)
			if got != tt.want {
				t.Errorf("selectedManualCreditRewardMRG() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestNormalizeAdminCreditWorkerID(t *testing.T) {
	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"github prefix", "github:alice", "github:alice"},
		{"worker github prefix", "worker:github:bob", "github:bob"},
		{"pure username", "charlie", "github:charlie"},
		{"empty string", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := normalizeAdminCreditWorkerID(tt.input)
			if got != tt.want {
				t.Errorf("normalizeAdminCreditWorkerID(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

func TestParseGitHubPullURL(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantOK  bool
		wantOrg string
		wantNum int
	}{
		{"valid PR URL", "https://github.com/mergeos-bounties/mergeos/pull/260", true, "mergeos-bounties", 260},
		{"valid PR URL with trailing slash", "https://github.com/org/repo/pull/42/", true, "org", 42},
		{"empty string", "", false, "", 0},
		{"not GitHub", "https://gitlab.com/org/repo/pull/1", false, "", 0},
		{"issues not pull", "https://github.com/org/repo/issues/1", false, "", 0},
		{"missing number", "https://github.com/org/repo/pull/", false, "", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			target, err := parseGitHubPullURL(tt.input)
			if tt.wantOK {
				if err != nil {
					t.Fatalf("parseGitHubPullURL(%q) unexpected error: %v", tt.input, err)
				}
				if target.Owner != tt.wantOrg {
					t.Errorf("Owner = %q, want %q", target.Owner, tt.wantOrg)
				}
				if target.IssueNumber != tt.wantNum {
					t.Errorf("IssueNumber = %d, want %d", target.IssueNumber, tt.wantNum)
				}
			} else {
				if err == nil {
					t.Errorf("parseGitHubPullURL(%q) expected error, got target=%#v", tt.input, target)
				}
			}
		})
	}
}

func TestRenderManualCreditComment(t *testing.T) {
	entry := LedgerEntry{
		Sequence:   42,
		EntryHash:  "abc123def",
		ToAccount:  "worker:github:alice",
	}
	body := renderManualCreditComment(entry, "worker:github:alice", 100, "bug-large", "https://scan.example.com/addr/xyz", "https://github.com/org/repo/pull/1")
	checks := []string{
		"MergeOS bounty credit approved",
		"Bug bounty - large",
		"100 MRG",
		"worker:github:alice",
		"abc123def",
		"Ledger sequence: 42",
		"github.com/org/repo/pull/1",
	}
	for _, check := range checks {
		if !strings.Contains(body, check) {
			t.Errorf("comment body missing %q\nbody:\n%s", check, body)
		}
	}
}

func TestAdminManualCreditReference(t *testing.T) {
	tests := []struct {
		name    string
		req     AdminManualCreditRequest
		wantOK  bool
		contain string
	}{
		{
			"PR URL without task",
			AdminManualCreditRequest{PRURL: "https://github.com/org/repo/pull/1", PRTitle: "fix bug"},
			true,
			"github.com/org/repo/pull/1",
		},
		{
			"reference fallback",
			AdminManualCreditRequest{Reference: "manual-payment", Note: "ignored"},
			true,
			"manual:manual-payment",
		},
		{
			"task ID + reference",
			AdminManualCreditRequest{TaskID: "task-1", Reference: "bonus"},
			true,
			"task:task-1;manual:bonus",
		},
		{
			"no PR URL and no reference",
			AdminManualCreditRequest{},
			false,
			"",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ref, err := adminManualCreditReference(tt.req)
			if tt.wantOK {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if !strings.Contains(ref, tt.contain) {
					t.Errorf("reference %q does not contain %q", ref, tt.contain)
				}
			} else {
				if err == nil {
					t.Errorf("expected error, got reference=%q", ref)
				}
			}
		})
	}
}

func TestIsGitHubUsername(t *testing.T) {
	tests := []struct {
		input string
		want  bool
	}{
		{"alice", true},
		{"a-b-c", true},
		{"user123", true},
		{"", false},
		{"-start", false},
		{"end-", false},
		{"User", false}, // uppercase
		{"toolongusername1234567890123456789012345", false}, // > 39 chars
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			got := isGitHubUsername(tt.input)
			if got != tt.want {
				t.Errorf("isGitHubUsername(%q) = %v, want %v", tt.input, got, tt.want)
			}
		})
	}
}
