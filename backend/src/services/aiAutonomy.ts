import { AiAutonomyProfile } from '../config.js';
import { AiAutonomyCapabilities, RiskGovernorState } from '../types.js';

export const resolveAutonomy = (
  profile: AiAutonomyProfile,
  envFlags: {
    aiPolicyAllowRiskRelaxation: boolean;
    aiPolicySweepAutoApply: boolean;
    autoBlacklistEnabled: boolean;
  },
  governorState: RiskGovernorState | null | undefined,
): AiAutonomyCapabilities => {
  const governorNormal = governorState === 'NORMAL';
  const allowRiskRelaxation = envFlags.aiPolicyAllowRiskRelaxation && governorNormal;

  switch (profile) {
    case 'standard':
      return {
        canAutoApplyTuningTighten: true,
        canAutoApplyTuningRelax: false,
        canAutoSweepToHome: envFlags.aiPolicySweepAutoApply,
        canPauseGrid: true,
        canResumeGrid: false,
        canAutoBlacklistSymbols: envFlags.autoBlacklistEnabled,
        canEnableUnwindPlans: false,
      };
    case 'pro':
      return {
        canAutoApplyTuningTighten: true,
        canAutoApplyTuningRelax: allowRiskRelaxation,
        canAutoSweepToHome: envFlags.aiPolicySweepAutoApply,
        canPauseGrid: true,
        canResumeGrid: allowRiskRelaxation,
        canAutoBlacklistSymbols: envFlags.autoBlacklistEnabled,
        canEnableUnwindPlans: false,
      };
    case 'aggressive':
      return {
        canAutoApplyTuningTighten: true,
        canAutoApplyTuningRelax: allowRiskRelaxation,
        canAutoSweepToHome: envFlags.aiPolicySweepAutoApply,
        canPauseGrid: true,
        canResumeGrid: allowRiskRelaxation,
        canAutoBlacklistSymbols: envFlags.autoBlacklistEnabled,
        canEnableUnwindPlans: false,
      };
    case 'safe':
    default:
      return {
        canAutoApplyTuningTighten: false,
        canAutoApplyTuningRelax: false,
        canAutoSweepToHome: false,
        canPauseGrid: true,
        canResumeGrid: false,
        canAutoBlacklistSymbols: false,
        canEnableUnwindPlans: false,
      };
  }
};
