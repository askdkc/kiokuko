import {readCorrectionClassification,correctionSourceCurrent,type CorrectionEnrichment} from '../memory/correction-classification.js'
import {randomUUID} from 'node:crypto'
import {readEntry} from '../memory/entries.js'
import {correctionSource,unclassifiedCorrection,compatibilityDecisionConflicts,type CorrectionSource,type CorrectionRetrieval,type CorrectionMode,type CorrectionClassification} from '../memory/correction-contract.js'
import {canonicalContentHash} from '../serialization/validate.js'
import type {SqliteDatabase} from '../db/adapter.js'
import {KiokukoError} from '../errors.js'

export interface CorrectionRecall {
  schema:'correction-context-v1';recallId:string;requestDigest:string;itemsDigest:string
  retrieval:CorrectionRetrieval;modelInput:'unobserved';sources:CorrectionSource[]
}
/** Process-local read receipts. Never stores a memory, transcript or model attestation. */
export class CorrectionRecallBook {
  readonly #receipts=new Map<string,{at:number;value:CorrectionRecall}>()
  #lastRetrieval:CorrectionRetrieval='not_requested'
  constructor(readonly now=()=>performance.now(),readonly classification?:{configurationDigest:string;mode:CorrectionMode}){}
  observeAttempt(){this.#lastRetrieval='unavailable'}
  remember(db:SqliteDatabase,query:unknown,items:readonly {workspace:string;entryId:string}[],enrichment?:{results:ReadonlyMap<string,CorrectionClassification>;mode:CorrectionMode}):CorrectionRecall {
    const sources=items.flatMap(item=>{
      const entry=readEntry(db,{workspace:item.workspace,entryId:item.entryId})
      return entry.provenance.type==='interaction_capture'&&entry.provenance.reference==='user_correction'
        ?[correctionSource(entry,item.workspace==='global'?'global':'project',enrichment?.results.get(entry.id)??(this.classification?readCorrectionClassification(db,entry,this.classification.configurationDigest):unclassifiedCorrection(entry,'provider_unavailable')),enrichment?.mode??this.classification?.mode??'shadow')]:[]
    })
    this.#expire()
    if(this.#receipts.size>=64)this.#receipts.delete(this.#receipts.keys().next().value!)
    const value:CorrectionRecall={schema:'correction-context-v1',recallId:randomUUID(),requestDigest:canonicalContentHash(query),itemsDigest:canonicalContentHash(items),
      retrieval:sources.length?'retrieved':'no_correction',modelInput:'unobserved',sources}
    this.#receipts.set(value.recallId,{at:this.now(),value})
    this.#lastRetrieval=value.retrieval
    return value
  }
  async rememberWithClassification(db:SqliteDatabase,query:unknown,items:readonly {workspace:string;entryId:string}[],classifier?:CorrectionEnrichment,signal:AbortSignal=AbortSignal.timeout(5000)):Promise<CorrectionRecall>{
    if(!classifier)return this.remember(db,query,items)
    const results=new Map<string,CorrectionClassification>()
    for(const item of items){
      const entry=readEntry(db,{workspace:item.workspace,entryId:item.entryId})
      if(entry.provenance.type==='interaction_capture'&&entry.provenance.reference==='user_correction'){const result=await classifier.classify(entry,signal);if(result.state==='stale')throw new KiokukoError('CONFLICT','Correction changed during semantic classification');results.set(entry.id,result)}
    }
    signal.throwIfAborted()
    return this.remember(db,query,items,{results,mode:classifier.mode})
  }
  #expire(){for(const [id,receipt]of this.#receipts)if(this.now()-receipt.at>30*60*1000)this.#receipts.delete(id)}
  check(db:SqliteDatabase|undefined,recallId:string|undefined,decision:{kind:string;target:string;basis:string;requiredVersion?:string;observedVersion?:string}){
    this.#expire()
    const receipt=recallId===undefined?undefined:this.#receipts.get(recallId)?.value
    if(recallId!==undefined&&!receipt)throw new KiokukoError('CONFLICT','Recall receipt is unavailable in this connection')
    const base={retrieval:receipt?.retrieval??this.#lastRetrieval,binding:receipt?'bound' as const:'missing' as const,modelInput:'unobserved' as const,verification:'unverified' as const,authorizationGranted:false as const,
      target:decision.target,decisionDigest:canonicalContentHash(decision),sources:receipt?.sources??[],...(receipt?{requestDigest:receipt.requestDigest,itemsDigest:receipt.itemsDigest}:{})}
    if(!receipt)return {...base,state:'unverified',reason:this.#lastRetrieval==='not_requested'?'not_requested':'recall_receipt_not_bound'}
    if(receipt.retrieval!=='retrieved')return {...base,state:'unverified',reason:receipt.retrieval}
    if(!db)throw new KiokukoError('SERVICE_UNAVAILABLE','Correction source is unavailable')
    const current=receipt.sources.every(source=>{
      try {const entry=readEntry(db,{workspace:source.workspace,entryId:source.entryId});return entry.status!=='superseded'&&correctionSourceCurrent(db,entry,source)}catch{return false}
    })
    if(!current)return {...base,state:'stale',reason:'correction_source_changed'}
    if(compatibilityDecisionConflicts(receipt.sources,decision))return {...base,state:'contradiction',reason:'version_only_compatibility_rejection'}
    return {...base,state:'unverified',reason:decision.kind==='completion'?'host_verification_unobserved':'no_machine_verified_application'}
  }
}
