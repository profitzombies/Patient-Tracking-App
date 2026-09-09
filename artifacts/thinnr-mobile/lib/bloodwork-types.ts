export interface BloodworkReport {
  id: string;
  patientId: string;
  title: string;
  reportDate: string | null;
  uploadedAt: string;
  version: number;
  kind: 'images' | 'pdf';
  fileCount: number;
  pageCount: number;
  extractionStatus: 'queued' | 'processing' | 'completed' | 'failed';
  extractionError: string | null;
  reviewStatus: 'unreviewed';
}

export interface BloodworkFile {
  id: string;
  position: number;
  mimeType: string;
  size: number;
  pageCount: number;
  width: number | null;
  height: number | null;
}

export interface BloodworkResult {
  id: string;
  reportId: string;
  sourceFileId: string;
  sourcePage: number;
  position: number;
  testName: string | null;
  valueText: string | null;
  units: string | null;
  referenceRange: string | null;
  labFlag: string | null;
  uncertain: boolean;
  version: number;
  reviewStatus: 'unreviewed';
  updatedAt: string;
  corrected: boolean;
}

export interface BloodworkDetail {
  report: BloodworkReport;
  files: BloodworkFile[];
  results: BloodworkResult[];
}

export interface BloodworkCorrection {
  id: string;
  resultId: string;
  actorRole: 'patient' | 'provider' | 'hq';
  createdAt: string;
  before: {
    testName: string | null;
    valueText: string | null;
    units: string | null;
    referenceRange: string | null;
    labFlag: string | null;
    uncertain: boolean;
  };
  after: {
    testName: string | null;
    valueText: string | null;
    units: string | null;
    referenceRange: string | null;
    labFlag: string | null;
    uncertain: boolean;
  };
  version: number;
}
