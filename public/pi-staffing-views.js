// Ledger views and manual adjustments use the same server plans as chat cards.
(() => {
    const tr = text => globalThis.PiI18n?.t(text) || text;
    const node = (tag, text, attrs = {}) => { const el=document.createElement(tag); if(text!==undefined)el.textContent=text; for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);return el; };
    let cards;
    const kindLabels = { project:'项目',leave:'请假',training:'培训',unavailable:'不可用',reserved:'预占',confirmed:'正式确认',cancelled:'已释放' };
    function mount(panel,{request,status,refresh}) {
        if (!cards) cards=globalThis.PiStaffingCards.create({fetch:async(url,options)=>request(url.replace('/api/pi/staffing',''),options)});
        const root=node('section',undefined,{class:'staffing-views','aria-label':tr('人员调配台账')}), notice=node('p','',{role:'status','aria-live':'polite'});
        panel.append(root);root.append(node('h2',tr('核查与调整')),notice);
        const tabs=node('nav',undefined,{'aria-label':tr('台账视图'),class:'staffing-view-tabs'});
        let view='projects',generation=0,busy=false;
        const controls=node('div',undefined,{class:'staffing-form-grid'}), results=node('section',undefined,{'aria-live':'polite',class:'staffing-view-results'});
        function field(parent,label,id,type='text',value='') {const wrap=node('label',tr(label),{for:id}),input=node('input',undefined,{id,type});input.value=value;wrap.append(input);parent.append(wrap);return input;}
        function select(parent,label,id,items) {const wrap=node('label',tr(label),{for:id}),input=node('select',undefined,{id}); for(const [value,title]of items)input.append(node('option',title,{value}));wrap.append(input);parent.append(wrap);return input;}
        const departments=[...new Set(status.people.map(p=>p.department))];
        const department=select(controls,'事业部','staffing-view-department',departments.map(d=>[d,d]));
        const first=status.projects[0],today=status.today;
        const start=field(controls,'开始日','staffing-view-start','date',first?.start||today),end=field(controls,'结束日','staffing-view-end','date',first?.end||today);
        const refreshButton=node('button',tr('查询最新台账'),{id:'staffing-view-refresh',type:'button'});controls.append(refreshButton);
        const paging=node('div',undefined,{class:'staffing-actions'});let offset=0,previousOffsets=[];
        async function load() {
            const ticket=++generation; notice.textContent=tr('正在读取台账…');
            try {const params=new URLSearchParams({kind:view,offset:String(offset),limit:'100'}); if(department.value)params.set('department',department.value);if(view!=='projects'){params.set('start',start.value);params.set('end',end.value);}
                const data=await request('/views?'+params);if(ticket!==generation||!root.isConnected)return;
                results.replaceChildren();paging.replaceChildren();notice.textContent=tr('台账版本：{0}').replace('{0}',data.revision)+' · '+(data.warning||'');
                const rows=data.projects||data.people;if(!rows.length)results.append(node('p',tr('此范围没有记录。请调整事业部或日期。')));
                if(view==='projects')for(const project of rows) {
                    const row=node('article',undefined,{'data-staffing-project':project.id,class:'staffing-project-row'});
                    row.append(node('h3',project.name),node('p',project.start+' 至 '+project.end+' · '+tr('最低人数')+' '+project.minimum),
                        node('p',tr(project.coverage.inactive?'项目已取消':project.coverage.satisfied?'人数和直签已达标':'人员安排有缺口')),node('p',project.coverage.inactive?'':tr(project.coverage.allConfirmed?'全部人员已正式确认':'尚未全部正式确认')));
                    if(project.lifecycle&&project.lifecycle.state!=='active')row.append(node('p',tr(project.lifecycle.state==='ended'?'项目提前结束':'项目已取消')+' · '+tr('释放开始日')+' '+project.lifecycle.effectiveDate));
                    for(const segment of project.coverage.segments)row.append(node('p',segment.start+' 至 '+segment.end+' · '+tr('已安排人数')+' '+segment.count+' · '+tr('还缺人数')+' '+segment.missing+' · '+tr(segment.missingDirect?'缺直签':'直签已满足')));
                    const names=new Map(status.people.map(p=>[p.id,p.name]));row.append(node('p',tr('已安排人员')+'：'+project.team.map(o=>(names.get(o.personId)||o.personId)+' · '+o.personId+' · '+o.start+' 至 '+o.end+' · '+tr(kindLabels[o.state])).join('，')));
                    const adjust=node('button',tr('调整此项目'),{type:'button'});adjust.addEventListener('click',()=>{projectSelect.value=project.id;updateFields();editor.scrollIntoView({block:'nearest'});});row.append(adjust);results.append(row);
                }
                else for(const person of rows) {
                    const row=node('article',undefined,{[view==='availability'?'data-staffing-available':'data-staffing-person-calendar']:person.id,class:'staffing-person-row'});
                    row.append(node('h3',person.name+' · '+person.id),node('p',person.department+' · '+tr(person.direct?'直签':'非直签')+' · '+tr('近90天项目天数')+' '+person.workDays));
                    if(view==='people')for(const o of person.occupancies)row.append(node('p',(o.projectName||tr(kindLabels[o.kind]))+' · '+o.start+' 至 '+o.end+' · '+tr(kindLabels[o.state])));
                    results.append(row);
                }
                const nextOffset=data.nextOffset??(offset+rows.length<data.total?offset+rows.length:null);
                for(const [label,isNext,disabled]of [['上一页',false,!previousOffsets.length],['下一页',true,nextOffset===null]]){const b=node('button',tr(label),{type:'button'});b.disabled=disabled;b.addEventListener('click',()=>{if(isNext){previousOffsets.push(offset);offset=nextOffset;}else offset=previousOffsets.pop()??0;void load();});paging.append(b);}
                paging.append(node('span',tr('记录总数')+'：'+data.total));
            } catch(error){if(ticket===generation&&root.isConnected)notice.textContent=error.message;}
        }
        for(const [name,label]of [['projects','项目安排'],['availability','可用人员'],['people','人员日历']]){const b=node('button',tr(label),{type:'button','data-staffing-view':name});b.addEventListener('click',()=>{view=name;offset=0;previousOffsets=[];for(const el of tabs.children)el.setAttribute('aria-pressed',String(el===b));void load();});b.setAttribute('aria-pressed',String(name===view));tabs.append(b);}
        refreshButton.addEventListener('click',()=>{offset=0;previousOffsets=[];void load();});root.append(tabs,controls,results,paging);
        const editor=node('section',undefined,{class:'staffing-manual-editor','aria-label':tr('手动安排变更')});editor.append(node('h3',tr('准备具体变更')),node('p',tr('检查方案后，再确认保存。请假会保留原项目安排并标记缺口。')));
        const form=node('div',undefined,{class:'staffing-form-grid'});editor.append(form);
        const operation=select(form,'操作','staffing-change-kind',[['add','补充人员'],['absence','登记请假或培训'],['formalize','将已有预占正式确认'],['replace','区间换人'],['reschedule','整体改期'],['extend','延长项目'],['withdraw','撤回人员'],['early-end','提前结束'],['cancel','取消项目']].map(([id,label])=>[id,tr(label)]));
        const projectSelect=select(form,'项目','staffing-change-project',status.projects.map(p=>[p.id,p.name+' · '+p.id]));
        const personSelect=select(form,'人员','staffing-change-person',status.people.map(p=>[p.id,p.name+' · '+p.id]));
        const absenceKind=select(form,'无法参加的原因','staffing-change-absence-kind',[['leave',tr('请假')],['training',tr('培训')],['unavailable',tr('不可用')]]);
        const occupancy=select(form,'原安排','staffing-change-occupancy',[]);
        const replacement=select(form,'替换人员','staffing-change-replacement',status.people.map(p=>[p.id,p.name+' · '+p.id+' · '+p.department]));
        const changeStart=field(form,'开始日','staffing-change-start','date',first?.start||today),changeEnd=field(form,'结束日','staffing-change-end','date',first?.end||today);
        const effective=field(form,'释放开始日','staffing-change-effective','date',today),reason=field(form,'变更原因','staffing-change-reason');
        const borrowWrap=node('label',undefined,{class:'staffing-person-choice'}),borrow=node('input',undefined,{type:'checkbox',id:'staffing-change-borrow'});borrowWrap.append(borrow,node('span',tr('仅此方案允许跨事业部借人')));form.append(borrowWrap);
        const candidates=node('fieldset',undefined,{id:'staffing-add-people'});candidates.append(node('legend',tr('本次新增人员')));form.append(candidates);
        const preview=node('div',undefined,{id:'staffing-page-plan'}),prepare=node('button',tr('检查变更方案'),{id:'staffing-prepare-adjustment',type:'button'});editor.append(prepare,preview);root.append(editor);
        const show=(element,visible)=>{element.closest('label').hidden=!visible;};
        async function updateFields() {
            const action=operation.value,p=status.projects.find(p=>p.id===projectSelect.value);projectSelect.closest('label').hidden=action==='absence';
            show(personSelect,action==='absence');show(absenceKind,action==='absence');show(occupancy,['replace','withdraw'].includes(action));show(replacement,action==='replace');
            show(changeStart,['absence','replace','reschedule'].includes(action));show(changeEnd,['absence','replace','reschedule','extend'].includes(action));show(effective,['withdraw','cancel','early-end'].includes(action));show(reason,!['add','formalize'].includes(action));borrowWrap.hidden=action!=='replace';candidates.hidden=action!=='add';
            occupancy.replaceChildren();for(const o of status.occupancies.filter(o=>o.projectId===p?.id&&o.kind==='project'&&o.state!=='cancelled'))occupancy.append(node('option',(status.people.find(p=>p.id===o.personId)?.name||o.personId)+' · '+o.personId+' · '+o.start+' 至 '+o.end,{value:o.id}));
            if(p){changeStart.value=p.start;changeEnd.value=p.end;}
            if(action==='add'&&p){try{const data=await request('/recommend',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:'recommend',project:p})});if(!root.isConnected||operation.value!=='add'||projectSelect.value!==p.id)return;
                candidates.replaceChildren(node('legend',tr('本次新增人员')),node('p',tr('已安排人数')+' '+new Set(data.existingTeam.map(o=>o.personId)).size+' · '+tr('还需新增')+' '+data.additionalNeeded));const selected=new Set(data.selected.map(p=>p.id));
                for(const person of new Map([...data.candidates,...data.selected].map(p=>[p.id,p])).values()){const label=node('label',undefined,{class:'staffing-person-choice'}),input=node('input',undefined,{type:'checkbox','data-staffing-add-person':person.id});input.checked=selected.has(person.id);label.append(input,node('span',person.name+' · '+person.id+' · '+tr(person.direct?'直签':'非直签')));candidates.append(label);}
            }catch(error){if(root.isConnected)notice.textContent=error.message;}}
        }
        operation.addEventListener('change',()=>void updateFields());projectSelect.addEventListener('change',()=>void updateFields());
        let pending;try{pending=sessionStorage.getItem('pivane.staffing.page-prepare');}catch{}
        function inspect(plan){preview.replaceChildren();const card=cards.renderPage(plan);if(card)preview.append(card);}
        function clearPending(){pending=null;try{sessionStorage.removeItem('pivane.staffing.page-prepare');}catch{}}
        async function check(){if(busy||!pending)return;busy=true;try{const receipt=await request('/operations/'+encodeURIComponent(pending));if(receipt.state==='completed'){clearPending();inspect(receipt.result);}else notice.textContent=tr('结果尚未确定。请继续核对状态，不要重复提交。');}catch(error){notice.textContent=error.message;}finally{busy=false;prepare.disabled=Boolean(pending);}}
        if(pending){prepare.disabled=true;const checkButton=node('button',tr('查询原操作结果'),{type:'button'});checkButton.addEventListener('click',()=>void check());editor.append(checkButton);}
        prepare.addEventListener('click',async()=>{
            if(busy||pending)return;busy=true;prepare.disabled=true;let requestId;
            try{const current=await request('/status');requestId=crypto.randomUUID();const input={requestId,expectedRevision:current.revision};let path='/adjust';const action=operation.value;
                if(action==='add'){path='/prepare';input.project=status.projects.find(p=>p.id===projectSelect.value);input.personIds=[...candidates.querySelectorAll('input:checked')].map(el=>el.dataset.staffingAddPerson);}
                else if(action==='absence')Object.assign(input,{kind:'absence',personId:personSelect.value,absenceKind:absenceKind.value,start:changeStart.value,end:changeEnd.value,reason:reason.value});
                else if(action==='formalize')Object.assign(input,{kind:'formalize',projectId:projectSelect.value});
                else if(action==='replace')Object.assign(input,{kind:'replace',projectId:projectSelect.value,occupancyId:occupancy.value,replacementPersonId:replacement.value,start:changeStart.value,end:changeEnd.value,reason:reason.value,allowCrossDepartment:borrow.checked});
                else if(['withdraw','cancel','early-end'].includes(action))Object.assign(input,{kind:'release',releaseKind:action,projectId:projectSelect.value,...(action==='withdraw'?{occupancyId:occupancy.value}:{}),effectiveDate:effective.value,reason:reason.value});
                else Object.assign(input,{kind:action,projectId:projectSelect.value,...(action==='reschedule'?{start:changeStart.value}:{}),end:changeEnd.value,reason:reason.value});
                pending=requestId;try{sessionStorage.setItem('pivane.staffing.page-prepare',pending);}catch{}
                const plan=await request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});clearPending();if(root.isConnected)inspect(plan);
            }catch(error){if(error.status&&error.status<500)clearPending();notice.textContent=pending?tr('提交结果待核对。请查询原操作，不要重新提交。'):error.message;if(pending){const b=node('button',tr('查询原操作结果'),{type:'button'});b.addEventListener('click',()=>void check());preview.replaceChildren(b);}}
            finally{busy=false;prepare.disabled=Boolean(pending);}
        });
        void load();void updateFields();
    }
    globalThis.PiStaffingViews={mount};
})();
