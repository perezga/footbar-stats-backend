export type FavFoot = 'r' | 'l' | 'b' | 'n';
export type Gender = 'm' | 'f';
export type AgeCategory =
  | 'U6'
  | 'U7'
  | 'U8'
  | 'U9'
  | 'U10'
  | 'U11'
  | 'U12'
  | 'U13'
  | 'U14'
  | 'U15'
  | 'U16'
  | 'U17'
  | 'U18'
  | 'U19'
  | 'SNR'
  | 'VTR';
export type MatchType = '11' | 'ss' | 'tr' | 'ru';
export type Position =
  | 'gk'
  | 'rb'
  | 'cb'
  | 'lb'
  | 'rwb'
  | 'lwb'
  | 'cdm'
  | 'cm'
  | 'cam'
  | 'rm'
  | 'lm'
  | 'rw'
  | 'lw'
  | 'cf'
  | 'st';
export type Strength = 'tec' | 'pac' | 'sta' | 'sho' | 'un';

export interface GeoPoint {
  type: 'Point';
  coordinates: [number, number] | [number, number, number];
}

export interface TrackerData {
  tracker_mac?: number | string | null;
  tracker_name?: string | null;
}

export interface ProfileAPI {
  user_id: number | null;
  nickname: string;
  fav_foot: FavFoot | null;
  fav_position: string;
  first_name: string;
  last_name: string;
  gender: Gender;
  d_o_b: string;
  profile_pic: string;
  age_category: AgeCategory;
  height: number;
  weight: number;
  strength: Strength;
  country_flag: string;
}

export interface SessionListAPI {
  id: number;
  start_date: string;
  stop_date: string;
  title: string;
  location: GeoPoint;
  match_type: MatchType;
  position?: Position;
  score_stars?: number;
  tracker_data?: TrackerData;
}

export interface DistanceBin {
  index: string;
  low: number;
  normal: number;
  high: number;
}

export interface SessionAPI extends SessionListAPI {
  playing_time: number;
  distance: number;
  pass_count: number;
  shot_count: number;
  shot_speed: number;
  avg_shot_speed: number;
  dribble_count: number;
  time_with_ball: number;
  activity: number;
  time_running: number;
  run_count: number | null;
  sprint_count: number;
  avg_sprint_speed: number;
  sprint_speed: number;
  hsr_plus: number;
  stop_and_go: number | null;
  acceleration: number | null;
  distance_5min: DistanceBin[] | null;
}

export interface PaginatedSessionList {
  count: number;
  next: string | null;
  previous: string | null;
  results: SessionListAPI[];
}
