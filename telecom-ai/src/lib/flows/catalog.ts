import type { FlowStep } from "./types";

/**
 * Curated engineering summaries of well-known procedures. They are NOT authoritative: each one names
 * the clause that defines the procedure and is verified step-by-step against that clause when the
 * spec is indexed. Steps that cannot be matched in the indexed clause are shown as unverified.
 * `match` lists message-name variants searched for in the clause text (normalised, case-insensitive).
 */
export interface CuratedFlow {
  id: string;
  title: string;
  generation: "5g" | "lte";
  spec: string;
  clause: string;
  keywords: RegExp;
  participants: string[];
  steps: (Omit<FlowStep, "status" | "citation" | "label"> & { match?: string[] })[];
}

export const CURATED_FLOWS: CuratedFlow[] = [
  {
    id: "5g-registration",
    title: "5GS initial registration (general registration)",
    generation: "5g",
    spec: "23.502",
    clause: "4.2.2.2.2",
    keywords: /\b(5g|5gs|nr)?\s*registration\b(?!.*(update|deregistration))/i,
    participants: ["UE", "gNB", "AMF", "AUSF", "UDM", "PCF", "SMF"],
    steps: [
      { from: "UE", to: "gNB", message: "AN message (AN parameters, Registration Request)", interface: "Uu", protocol: "RRC + NAS-5GS", match: ["Registration Request"] },
      { from: "gNB", to: "AMF", message: "N2 message (Registration Request, location, RAT type)", interface: "N2", protocol: "NGAP", match: ["N2 message"] },
      { from: "AMF", to: "UE", message: "Identity Request / Response (SUCI)", optional: true, condition: "if UE identity not available", interface: "N1", protocol: "NAS-5GS", match: ["Identity Request"] },
      { from: "AMF", to: "AUSF", message: "Authentication / security (AUSF selection, Nausf_UEAuthentication)", interface: "N12", protocol: "HTTP/2 SBI", match: ["AUSF"] },
      { from: "AMF", to: "UE", message: "NAS Security Mode Command / Complete", interface: "N1", protocol: "NAS-5GS", match: ["Security"] },
      { from: "AMF", to: "UDM", message: "Nudm_UECM_Registration", interface: "N8", protocol: "HTTP/2 SBI", match: ["Nudm_UECM_Registration"] },
      { from: "AMF", to: "UDM", message: "Nudm_SDM_Get / Nudm_SDM_Subscribe", interface: "N8", protocol: "HTTP/2 SBI", match: ["Nudm_SDM_Get"] },
      { from: "AMF", to: "PCF", message: "Npcf_AMPolicyControl_Create", optional: true, condition: "if PCF is used for access and mobility policy", interface: "N15", protocol: "HTTP/2 SBI", match: ["Npcf_AMPolicyControl_Create"] },
      { from: "AMF", to: "SMF", message: "Nsmf_PDUSession_UpdateSMContext / ReleaseSMContext", optional: true, condition: "if existing PDU sessions need updating", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_UpdateSMContext"] },
      { from: "AMF", to: "UE", message: "Registration Accept", interface: "N1", protocol: "NAS-5GS", match: ["Registration Accept"] },
      { from: "UE", to: "AMF", message: "Registration Complete", optional: true, condition: "when required by the Registration Accept contents", interface: "N1", protocol: "NAS-5GS", match: ["Registration Complete"] },
    ],
  },
  {
    id: "5g-pdu-session",
    title: "UE-requested PDU Session Establishment (non-roaming / LBO)",
    generation: "5g",
    spec: "23.502",
    clause: "4.3.2.2.1",
    keywords: /\bpdu session\b.*\b(establish|setup|set up)|\b(establish|setup)\w*\b.*\bpdu session/i,
    participants: ["UE", "gNB", "AMF", "SMF", "UDM", "PCF", "UPF"],
    steps: [
      { from: "UE", to: "AMF", message: "PDU Session Establishment Request (in UL NAS Transport)", interface: "N1", protocol: "NAS-5GS", match: ["PDU Session Establishment Request"] },
      { from: "AMF", to: "SMF", message: "Nsmf_PDUSession_CreateSMContext Request", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_CreateSMContext"] },
      { from: "SMF", to: "UDM", message: "Nudm_SDM_Get / Nudm_UECM_Registration", optional: true, condition: "if subscription data not available", interface: "N10", protocol: "HTTP/2 SBI", match: ["Nudm_SDM_Get"] },
      { from: "SMF", to: "AMF", message: "Nsmf_PDUSession_CreateSMContext Response", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_CreateSMContext"] },
      { from: "SMF", to: "PCF", message: "Npcf_SMPolicyControl_Create", optional: true, condition: "if dynamic PCC is deployed", interface: "N7", protocol: "HTTP/2 SBI", match: ["Npcf_SMPolicyControl_Create"] },
      { from: "SMF", to: "UPF", message: "N4 Session Establishment Request / Response", interface: "N4", protocol: "PFCP", match: ["N4 Session Establishment"] },
      { from: "SMF", to: "AMF", message: "Namf_Communication_N1N2MessageTransfer (N2 SM info, N1 PDU Session Establishment Accept)", interface: "N11", protocol: "HTTP/2 SBI", match: ["Namf_Communication_N1N2MessageTransfer"] },
      { from: "AMF", to: "gNB", message: "N2 PDU Session Request (NAS PDU Session Establishment Accept)", interface: "N2", protocol: "NGAP", match: ["N2 PDU Session Request"] },
      { from: "gNB", to: "UE", message: "AN-specific resource setup (incl. PDU Session Establishment Accept)", interface: "Uu", protocol: "RRC", match: ["AN-specific resource setup"] },
      { from: "gNB", to: "AMF", message: "N2 PDU Session Response (AN tunnel info)", interface: "N2", protocol: "NGAP", match: ["N2 PDU Session Response"] },
      { from: "AMF", to: "SMF", message: "Nsmf_PDUSession_UpdateSMContext Request", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_UpdateSMContext"] },
      { from: "SMF", to: "UPF", message: "N4 Session Modification Request / Response", interface: "N4", protocol: "PFCP", match: ["N4 Session Modification"] },
      { from: "SMF", to: "AMF", message: "Nsmf_PDUSession_UpdateSMContext Response", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_UpdateSMContext"] },
    ],
  },
  {
    id: "5g-service-request",
    title: "UE Triggered Service Request",
    generation: "5g",
    spec: "23.502",
    clause: "4.2.3.2",
    keywords: /\bservice request\b/i,
    participants: ["UE", "gNB", "AMF", "SMF", "UPF"],
    steps: [
      { from: "UE", to: "AMF", message: "Service Request (via AN, in N2 message)", interface: "N1/N2", protocol: "NAS-5GS / NGAP", match: ["Service Request"] },
      { from: "AMF", to: "SMF", message: "Nsmf_PDUSession_UpdateSMContext Request", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_UpdateSMContext"] },
      { from: "SMF", to: "UPF", message: "N4 Session Modification Request / Response", optional: true, condition: "if UPF selection or tunnel change required", interface: "N4", protocol: "PFCP", match: ["N4 Session Modification"] },
      { from: "AMF", to: "gNB", message: "N2 Request (N2 SM information, Service Accept)", interface: "N2", protocol: "NGAP", match: ["Service Accept"] },
      { from: "gNB", to: "UE", message: "RRC Connection Reconfiguration", interface: "Uu", protocol: "RRC", match: ["RRC"] },
      { from: "gNB", to: "AMF", message: "N2 Request Acknowledge (AN tunnel info)", interface: "N2", protocol: "NGAP", match: ["N2 Request Ack"] },
      { from: "AMF", to: "SMF", message: "Nsmf_PDUSession_UpdateSMContext Request (AN tunnel info)", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_UpdateSMContext"] },
      { from: "SMF", to: "UPF", message: "N4 Session Modification Request / Response", interface: "N4", protocol: "PFCP", match: ["N4 Session Modification"] },
    ],
  },
  {
    id: "5g-deregistration",
    title: "UE-initiated Deregistration",
    generation: "5g",
    spec: "23.502",
    clause: "4.2.2.3.2",
    keywords: /\bderegistration\b|\bderegister\b/i,
    participants: ["UE", "gNB", "AMF", "SMF", "UPF", "UDM", "PCF"],
    steps: [
      { from: "UE", to: "AMF", message: "Deregistration Request", interface: "N1", protocol: "NAS-5GS", match: ["Deregistration Request"] },
      { from: "AMF", to: "SMF", message: "Nsmf_PDUSession_ReleaseSMContext", condition: "for each established PDU session", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_ReleaseSMContext"] },
      { from: "SMF", to: "UPF", message: "N4 Session Release Request / Response", interface: "N4", protocol: "PFCP", match: ["N4 Session Release"] },
      { from: "AMF", to: "PCF", message: "Npcf_AMPolicyControl_Delete", optional: true, condition: "if AM policy association exists", interface: "N15", protocol: "HTTP/2 SBI", match: ["Npcf_AMPolicyControl_Delete"] },
      { from: "AMF", to: "UE", message: "Deregistration Accept", optional: true, condition: "unless deregistration type is switch-off", interface: "N1", protocol: "NAS-5GS", match: ["Deregistration Accept"] },
      { from: "AMF", to: "gNB", message: "N2 UE Context Release Command", interface: "N2", protocol: "NGAP", match: ["N2 UE Context Release"] },
    ],
  },
  {
    id: "5g-xn-handover",
    title: "Xn based inter NG-RAN handover (path switch)",
    generation: "5g",
    spec: "23.502",
    clause: "4.9.1.2",
    keywords: /\bxn\b.*handover|handover.*\bxn\b|\bpath switch/i,
    participants: ["UE", "S-gNB", "T-gNB", "AMF", "SMF", "UPF"],
    steps: [
      { from: "S-gNB", to: "T-gNB", message: "Handover preparation and execution (XnAP)", interface: "Xn", protocol: "XnAP", match: ["handover preparation"] },
      { from: "T-gNB", to: "AMF", message: "N2 Path Switch Request", interface: "N2", protocol: "NGAP", match: ["N2 Path Switch Request"] },
      { from: "AMF", to: "SMF", message: "Nsmf_PDUSession_UpdateSMContext Request", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_UpdateSMContext"] },
      { from: "SMF", to: "UPF", message: "N4 Session Modification Request / Response", interface: "N4", protocol: "PFCP", match: ["N4 Session Modification"] },
      { from: "UPF", to: "S-gNB", message: "End marker packet(s)", interface: "N3", protocol: "GTP-U", match: ["end marker"] },
      { from: "SMF", to: "AMF", message: "Nsmf_PDUSession_UpdateSMContext Response", interface: "N11", protocol: "HTTP/2 SBI", match: ["Nsmf_PDUSession_UpdateSMContext"] },
      { from: "AMF", to: "T-gNB", message: "N2 Path Switch Request Ack", interface: "N2", protocol: "NGAP", match: ["N2 Path Switch Request Ack"] },
      { from: "T-gNB", to: "S-gNB", message: "Release Resources", interface: "Xn", protocol: "XnAP", match: ["Release Resources"] },
    ],
  },
  {
    id: "5g-aka",
    title: "5G AKA authentication",
    generation: "5g",
    spec: "33.501",
    clause: "6.1.3.2",
    keywords: /\b5g[- ]?aka\b|\bauthentication\b.*\b5g|\b5g\b.*\bauthentication/i,
    participants: ["UE", "SEAF/AMF", "AUSF", "UDM/ARPF"],
    steps: [
      { from: "SEAF/AMF", to: "AUSF", message: "Nausf_UEAuthentication_Authenticate Request (SUCI or SUPI, serving network name)", interface: "N12", protocol: "HTTP/2 SBI", match: ["Nausf_UEAuthentication_Authenticate"] },
      { from: "AUSF", to: "UDM/ARPF", message: "Nudm_UEAuthentication_Get Request", interface: "N13", protocol: "HTTP/2 SBI", match: ["Nudm_UEAuthentication_Get"] },
      { from: "UDM/ARPF", to: "AUSF", message: "Nudm_UEAuthentication_Get Response (5G HE AV, SUPI)", interface: "N13", protocol: "HTTP/2 SBI", match: ["5G HE AV"] },
      { from: "AUSF", to: "SEAF/AMF", message: "Nausf_UEAuthentication_Authenticate Response (5G SE AV)", interface: "N12", protocol: "HTTP/2 SBI", match: ["5G SE AV"] },
      { from: "SEAF/AMF", to: "UE", message: "Authentication Request (RAND, AUTN, ngKSI, ABBA)", interface: "N1", protocol: "NAS-5GS", match: ["Authentication Request"] },
      { from: "UE", to: "SEAF/AMF", message: "Authentication Response (RES*)", interface: "N1", protocol: "NAS-5GS", match: ["Authentication Response"] },
      { from: "SEAF/AMF", to: "AUSF", message: "Nausf_UEAuthentication_Authenticate Request (RES*)", interface: "N12", protocol: "HTTP/2 SBI", match: ["RES*"] },
      { from: "AUSF", to: "SEAF/AMF", message: "Nausf_UEAuthentication_Authenticate Response (result, Kseaf, SUPI)", interface: "N12", protocol: "HTTP/2 SBI", match: ["KSEAF"] },
    ],
  },
  {
    id: "lte-attach",
    title: "E-UTRAN Initial Attach",
    generation: "lte",
    spec: "23.401",
    clause: "5.3.2.1",
    keywords: /\battach\b/i,
    participants: ["UE", "eNodeB", "MME", "HSS", "Serving GW", "PDN GW"],
    steps: [
      { from: "UE", to: "eNodeB", message: "Attach Request (with PDN Connectivity Request)", interface: "Uu", protocol: "RRC + NAS-EPS", match: ["Attach Request"] },
      { from: "eNodeB", to: "MME", message: "Initial UE Message (Attach Request)", interface: "S1-MME", protocol: "S1AP", match: ["Attach Request"] },
      { from: "MME", to: "HSS", message: "Authentication / security (Authentication Information Request/Answer)", interface: "S6a", protocol: "Diameter", match: ["Authentication"] },
      { from: "MME", to: "UE", message: "Authentication Request/Response; NAS Security Mode Command/Complete", interface: "S1-MME", protocol: "NAS-EPS", match: ["Security"] },
      { from: "MME", to: "HSS", message: "Update Location Request / Answer", interface: "S6a", protocol: "Diameter", match: ["Update Location Request"] },
      { from: "MME", to: "Serving GW", message: "Create Session Request", interface: "S11", protocol: "GTPv2-C", match: ["Create Session Request"] },
      { from: "Serving GW", to: "PDN GW", message: "Create Session Request", interface: "S5/S8", protocol: "GTPv2-C", match: ["Create Session Request"] },
      { from: "PDN GW", to: "Serving GW", message: "Create Session Response", interface: "S5/S8", protocol: "GTPv2-C", match: ["Create Session Response"] },
      { from: "Serving GW", to: "MME", message: "Create Session Response", interface: "S11", protocol: "GTPv2-C", match: ["Create Session Response"] },
      { from: "MME", to: "eNodeB", message: "Initial Context Setup Request (Attach Accept, Activate Default EPS Bearer Context Request)", interface: "S1-MME", protocol: "S1AP + NAS-EPS", match: ["Attach Accept"] },
      { from: "eNodeB", to: "UE", message: "RRC Connection Reconfiguration", interface: "Uu", protocol: "RRC", match: ["RRC Connection Reconfiguration"] },
      { from: "UE", to: "eNodeB", message: "RRC Connection Reconfiguration Complete", interface: "Uu", protocol: "RRC", match: ["RRC Connection Reconfiguration Complete"] },
      { from: "eNodeB", to: "MME", message: "Initial Context Setup Response", interface: "S1-MME", protocol: "S1AP", match: ["Initial Context Setup Response"] },
      { from: "UE", to: "MME", message: "Attach Complete (via Direct Transfer / Uplink NAS Transport)", interface: "S1-MME", protocol: "NAS-EPS", match: ["Attach Complete"] },
      { from: "MME", to: "Serving GW", message: "Modify Bearer Request / Response", interface: "S11", protocol: "GTPv2-C", match: ["Modify Bearer Request"] },
    ],
  },
];

export function matchCuratedFlow(query: string, generation: "lte" | "5g" | "both" | null): CuratedFlow | null {
  const candidates = CURATED_FLOWS.filter((f) => f.keywords.test(query));
  if (!candidates.length) return null;
  const pref = candidates.find((f) => generation === f.generation) ?? candidates[0]!;
  return pref;
}
